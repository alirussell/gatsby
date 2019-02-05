const _ = require(`lodash`)
const Remark = require(`remark`)
const Promise = require(`bluebird`)
const visit = require(`unist-util-visit`)
const hastToHTML = require(`hast-util-to-html`)
const toHAST = require(`mdast-util-to-hast`)

const htmlAstCacheKey = (context, node) => {
  const { pluginsCacheStr, pathPrefixCacheStr } = context
  return `transformer-remark-markdown-html-ast-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`
}
const astCacheKey = (context, node) => {
  const { pluginsCacheStr, pathPrefixCacheStr } = context
  return `transformer-remark-markdown-ast-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`
}

/**
 * Map that keeps track of generation of AST to not generate it multiple
 * times in parallel.
 *
 * @type {Map<string,Promise>}
 */
const ASTPromiseMap = new Map()

// ensure only one `/` in new url
const withPathPrefix = (url, pathPrefix) =>
  (pathPrefix + url).replace(/\/\//, `/`)

async function getMarkdownAST(context, markdownNode) {
  const {
    getNode,
    reporter,
    getCache,
    fileNodes,
    pluginOptions,
    pathPrefix,
    ...restApi
  } = context

  // Use Bluebird's Promise function "each" to run remark plugins serially.
  await Promise.each(pluginOptions.plugins, plugin => {
    const requiredPlugin = require(plugin.resolve)
    if (_.isFunction(requiredPlugin.mutateSource)) {
      return requiredPlugin.mutateSource(
        {
          markdownNode,
          files: fileNodes,
          getNode,
          reporter,
          cache: getCache(plugin.name),
          getCache,
          ...restApi,
        },
        plugin.pluginOptions
      )
    } else {
      return Promise.resolve()
    }
  })

  // Setup Remark. Make sure this only happens once
  const {
    commonmark = true,
    footnotes = true,
    pedantic = true,
    gfm = true,
    blocks,
  } = pluginOptions
  const remarkOptions = {
    gfm,
    commonmark,
    footnotes,
    pedantic,
  }
  if (_.isArray(blocks)) {
    remarkOptions.blocks = blocks
  }
  let remark = new Remark().data(`settings`, remarkOptions)
  // end setup remark

  const markdownAST = remark.parse(markdownNode.internal.content)

  if (pathPrefix) {
    // Ensure relative links include `pathPrefix`
    visit(markdownAST, [`link`, `definition`], node => {
      if (node.url && node.url.startsWith(`/`) && !node.url.startsWith(`//`)) {
        node.url = withPathPrefix(node.url, pathPrefix)
      }
    })
  }

  // source => parse (can order parsing for dependencies) => typegen
  //
  // source plugins identify nodes, provide id, initial parse, know
  // when nodes are created/removed/deleted
  // get passed cached DataTree and return list of clean and dirty nodes.
  // Also get passed `dirtyNodes` function which they can call with an array
  // of node ids which will then get re-parsed and the inferred schema
  // recreated (if inferring schema gets too expensive, can also
  // cache the schema until a query fails at which point recreate the
  // schema).
  //
  // parse plugins take data from source nodes and extend it, never mutate
  // it. Freeze all nodes once done so typegen plugins can't change it
  // this lets us save off the DataTree at that point as well as create
  // indexes.
  //
  // typegen plugins identify further types of data that should be lazily
  // computed due to their expense, or are hard to infer graphql type
  // (markdown ast), or are need user input in order to derive e.g.
  // markdown headers or date fields.
  //
  // wrap all resolve functions to (a) auto-memoize and (b) cache to disk any
  // resolve function that takes longer than ~10ms (do research on this
  // e.g. how long reading/writing to cache takes), and (c) track which
  // queries are based on which source nodes. Also if connection of what
  // which are always rerun if their underlying nodes change..
  //
  // every node type in DataTree gets a schema type automatically.
  // typegen plugins just modify the auto-generated types to add derived fields
  // as well as computationally expensive fields.

  // Use Bluebird's Promise function "each" to run remark plugins serially.
  await Promise.each(pluginOptions.plugins, plugin => {
    const requiredPlugin = require(plugin.resolve)
    if (_.isFunction(requiredPlugin)) {
      return requiredPlugin(
        {
          markdownAST,
          markdownNode,
          getNode,
          files: fileNodes,
          pathPrefix,
          reporter,
          cache: getCache(plugin.name),
          getCache,
          ...restApi,
        },
        plugin.pluginOptions
      )
    } else {
      return Promise.resolve()
    }
  })

  return markdownAST
}

async function getAST(context, markdownNode) {
  const { cache } = context
  const cacheKey = astCacheKey(context, markdownNode)
  const cachedAST = await cache.get(cacheKey)
  if (cachedAST) {
    return cachedAST
  } else if (ASTPromiseMap.has(cacheKey)) {
    // We are already generating AST, so let's wait for it
    return await ASTPromiseMap.get(cacheKey)
  } else {
    const ASTGenerationPromise = getMarkdownAST(context, markdownNode)
    ASTGenerationPromise.then(markdownAST => {
      cache.set(cacheKey, markdownAST)
      ASTPromiseMap.delete(cacheKey)
    }).catch(err => {
      ASTPromiseMap.delete(cacheKey)
      return err
    })
    // Save new AST to cache and return
    // We can now release promise, as we cached result
    ASTPromiseMap.set(cacheKey, ASTGenerationPromise)
    return ASTGenerationPromise
  }
}

async function getHTMLAst(context, markdownNode) {
  const { cache } = context
  const cachedAst = await cache.get(htmlAstCacheKey(context, markdownNode))
  if (cachedAst) {
    return cachedAst
  } else {
    const ast = await getAST(context, markdownNode)
    const htmlAst = toHAST(ast, { allowDangerousHTML: true })

    // Save new HTML AST to cache and return
    cache.set(htmlAstCacheKey(context, markdownNode), htmlAst)
    return htmlAst
  }
}

async function getHTML(context, markdownNode) {
  const ast = await getHTMLAst(context, markdownNode)
  // Save new HTML to cache and return
  const html = hastToHTML(ast, {
    allowDangerousHTML: true,
  })
  return html
}

module.exports = {
  getMarkdownAST,
  getHTML,
}
