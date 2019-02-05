const {
  GraphQLObjectType,
  GraphQLList,
  GraphQLString,
  GraphQLInt,
  GraphQLEnumType,
  GraphQLJSON,
  GraphQLBoolean,
} = require(`gatsby/graphql`)
const Remark = require(`remark`)
const select = require(`unist-util-select`)
const sanitizeHTML = require(`sanitize-html`)
const _ = require(`lodash`)
const visit = require(`unist-util-visit`)
const toHAST = require(`mdast-util-to-hast`)
const hastToHTML = require(`hast-util-to-html`)
const mdastToToc = require(`mdast-util-toc`)
const Promise = require(`bluebird`)
const unified = require(`unified`)
const parse = require(`remark-parse`)
const stringify = require(`remark-stringify`)
const english = require(`retext-english`)
const remark2retext = require(`remark-retext`)
const stripPosition = require(`unist-util-remove-position`)
const hastReparseRaw = require(`hast-util-raw`)
const prune = require(`underscore.string/prune`)
const {
  getConcatenatedValue,
  cloneTreeUntil,
  findLastTextNode,
} = require(`./hast-processing`)
const worker = require(`./worker`)

let pluginsCacheStr = ``
let pathPrefixCacheStr = ``
const astCacheKey = node =>
  `transformer-remark-markdown-ast-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`
const htmlCacheKey = node =>
  `transformer-remark-markdown-html-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`
const headingsCacheKey = node =>
  `transformer-remark-markdown-headings-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`
const tableOfContentsCacheKey = (node, appliedTocOptions) =>
  `transformer-remark-markdown-toc-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${JSON.stringify(
    appliedTocOptions
  )}-${pathPrefixCacheStr}`

/**
 * Map that keeps track of generation of AST to not generate it multiple
 * times in parallel.
 *
 * @type {Map<string,Promise>}
 */
const ASTPromiseMap = new Map()

let fileNodes

module.exports = (
  {
    type,
    pathPrefix,
    getNode,
    getNodesByType,
    cache,
    getCache: possibleGetCache,
    reporter,
    workerApi,
    ...rest
  },
  pluginOptions
) => {
  if (type.name !== `MarkdownRemark`) {
    return {}
  }
  pluginsCacheStr = pluginOptions.plugins.map(p => p.name).join(``)
  pathPrefixCacheStr = pathPrefix || ``
  const context = {
    pluginsCacheStr,
    pathPrefixCacheStr,
    pluginOptions,
  }

  return new Promise((resolve, reject) => {
    // Setup Remark.
    const {
      blocks,
      commonmark = true,
      footnotes = true,
      gfm = true,
      pedantic = true,
      tableOfContents = {
        heading: null,
        maxDepth: 6,
      },
    } = pluginOptions
    const tocOptions = tableOfContents
    const remarkOptions = {
      commonmark,
      footnotes,
      gfm,
      pedantic,
    }
    if (_.isArray(blocks)) {
      remarkOptions.blocks = blocks
    }
    let remark = new Remark().data(`settings`, remarkOptions)

    for (let plugin of pluginOptions.plugins) {
      const requiredPlugin = require(plugin.resolve)
      if (_.isFunction(requiredPlugin.setParserPlugins)) {
        for (let parserPlugin of requiredPlugin.setParserPlugins(
          plugin.pluginOptions
        )) {
          if (_.isArray(parserPlugin)) {
            const [parser, options] = parserPlugin
            remark = remark.use(parser, options)
          } else {
            remark = remark.use(parserPlugin)
          }
        }
      }
    }

    async function getAST(markdownNode) {
      const cacheKey = astCacheKey(markdownNode)
      const cachedAST = await cache.get(cacheKey)
      if (cachedAST) {
        return cachedAST
      } else if (ASTPromiseMap.has(cacheKey)) {
        // We are already generating AST, so let's wait for it
        return await ASTPromiseMap.get(cacheKey)
      } else {
        const ASTGenerationPromise = getMarkdownAST(markdownNode)
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

    async function getMarkdownAST(markdownNode) {
      // TODO test both paths
      if (workerApi) {
        // if (!fileNodes) {
        //   fileNodes = getNodesByType(`File`)
        // }
        const myContext = {
          pluginOptions,
          fileNodes,
          parentNode: getNode(markdownNode.parent),
        }
        return await workerApi.exec(
          require.resolve(`./worker`),
          `getMarkdownAST`,
          myContext,
          markdownNode
        )
      } else {
        const worker = require(`./worker`)
        const myContext = {
          cache,
          getCache: possibleGetCache,
          parentNode: getNode(markdownNode.parent),
          ...context,
        }
        return await worker.getMarkdownAST(myContext, markdownNode)
      }
    }

    async function getHeadings(markdownNode) {
      const cachedHeadings = await cache.get(headingsCacheKey(markdownNode))
      if (cachedHeadings) {
        return cachedHeadings
      } else {
        const ast = await getAST(markdownNode)
        const headings = select(ast, `heading`).map(heading => {
          return {
            value: _.first(select(heading, `text`).map(text => text.value)),
            depth: heading.depth,
          }
        })

        cache.set(headingsCacheKey(markdownNode), headings)
        return headings
      }
    }

    async function getTableOfContents(markdownNode, gqlTocOptions) {
      // fetch defaults
      let appliedTocOptions = { ...tocOptions, ...gqlTocOptions }
      // get cached toc
      const cachedToc = await cache.get(
        tableOfContentsCacheKey(markdownNode, appliedTocOptions)
      )
      if (cachedToc) {
        return cachedToc
      } else {
        const ast = await getAST(markdownNode)
        const tocAst = mdastToToc(ast, appliedTocOptions)

        let toc
        if (tocAst.map) {
          const addSlugToUrl = function(node) {
            if (node.url) {
              if (
                _.get(markdownNode, appliedTocOptions.pathToSlugField) ===
                undefined
              ) {
                console.warn(
                  `Skipping TableOfContents. Field '${
                    appliedTocOptions.pathToSlugField
                  }' missing from markdown node`
                )
                return null
              }
              node.url = [
                pathPrefix,
                _.get(markdownNode, appliedTocOptions.pathToSlugField),
                node.url,
              ]
                .join(`/`)
                .replace(/\/\//g, `/`)
            }
            if (node.children) {
              node.children = node.children.map(node => addSlugToUrl(node))
            }

            return node
          }
          tocAst.map = addSlugToUrl(tocAst.map)

          toc = hastToHTML(toHAST(tocAst.map))
        } else {
          toc = ``
        }
        cache.set(tableOfContentsCacheKey(markdownNode, appliedTocOptions), toc)
        return toc
      }
    }

    async function calcHtml(markdownNode) {
      // TODO test both paths
      if (workerApi) {
        // if (!fileNodes) {
        //   fileNodes = getNodesByType(`File`)
        // }
        const context = {
          pluginOptions,
          fileNodes,
          parentNode: getNode(markdownNode.parent),
        }
        return await workerApi.exec(
          require.resolve(`./worker`),
          `getHTML`,
          context,
          markdownNode
        )
      } else {
        const worker = require(`./worker`)
        const myContext = {
          cache,
          getCache: possibleGetCache,
          parentNode: getNode(markdownNode.parent),
          ...context,
        }
        return await worker.getHtml(myContext, markdownNode)
      }
    }

    async function getHTML(markdownNode) {
      const cachedHTML = await cache.get(htmlCacheKey(markdownNode))
      if (cachedHTML) {
        return cachedHTML
      } else {
        const html = await calcHtml(markdownNode)

        // Save new HTML to cache and return
        cache.set(htmlCacheKey(markdownNode), html)
        return html
      }
    }

    const HeadingType = new GraphQLObjectType({
      name: `MarkdownHeading`,
      fields: {
        value: {
          type: GraphQLString,
          resolve(heading) {
            return heading.value
          },
        },
        depth: {
          type: GraphQLInt,
          resolve(heading) {
            return heading.depth
          },
        },
      },
    })

    const HeadingLevels = new GraphQLEnumType({
      name: `HeadingLevels`,
      values: {
        h1: { value: 1 },
        h2: { value: 2 },
        h3: { value: 3 },
        h4: { value: 4 },
        h5: { value: 5 },
        h6: { value: 6 },
      },
    })

    const ExcerptFormats = new GraphQLEnumType({
      name: `ExcerptFormats`,
      values: {
        PLAIN: { value: `plain` },
        HTML: { value: `html` },
      },
    })

    return resolve({
      html: {
        type: GraphQLString,
        resolve(markdownNode) {
          return getHTML(markdownNode)
        },
      },
      htmlAst: {
        type: GraphQLJSON,
        resolve(markdownNode) {
          const myContext = {
            cache,
            getCache: possibleGetCache,
            parentNode: getNode(markdownNode.parent),
            ...context,
          }
          return worker.getHTMLAst(myContext, markdownNode).then(ast => {
            const strippedAst = stripPosition(_.clone(ast), true)
            return hastReparseRaw(strippedAst)
          })
        },
      },
      excerpt: {
        type: GraphQLString,
        args: {
          pruneLength: {
            type: GraphQLInt,
            defaultValue: 140,
          },
          truncate: {
            type: GraphQLBoolean,
            defaultValue: false,
          },
          format: {
            type: ExcerptFormats,
            defaultValue: `plain`,
          },
        },
        async resolve(markdownNode, { format, pruneLength, truncate }) {
          if (format === `html`) {
            if (pluginOptions.excerpt_separator) {
              const myContext = {
                cache,
                getCache: possibleGetCache,
                parentNode: getNode(markdownNode.parent),
                ...context,
              }
              const fullAST = await worker.getHTMLAst(myContext, markdownNode)
              const excerptAST = cloneTreeUntil(
                fullAST,
                ({ nextNode }) =>
                  nextNode.type === `raw` &&
                  nextNode.value === pluginOptions.excerpt_separator
              )
              return hastToHTML(excerptAST, {
                allowDangerousHTML: true,
              })
            }
            const myContext = {
              cache,
              getCache: possibleGetCache,
              parentNode: getNode(markdownNode.parent),
              ...context,
            }
            const fullAST = await worker.getHTMLAst(myContext, markdownNode)
            if (!fullAST.children.length) {
              return ``
            }

            const excerptAST = cloneTreeUntil(fullAST, ({ root }) => {
              const totalExcerptSoFar = getConcatenatedValue(root)
              return totalExcerptSoFar && totalExcerptSoFar.length > pruneLength
            })
            const unprunedExcerpt = getConcatenatedValue(excerptAST)
            if (!unprunedExcerpt) {
              return ``
            }

            if (pruneLength && unprunedExcerpt.length < pruneLength) {
              return hastToHTML(excerptAST, {
                allowDangerousHTML: true,
              })
            }

            const lastTextNode = findLastTextNode(excerptAST)
            const amountToPruneLastNode =
              pruneLength - (unprunedExcerpt.length - lastTextNode.value.length)
            if (!truncate) {
              lastTextNode.value = prune(
                lastTextNode.value,
                amountToPruneLastNode,
                `…`
              )
            } else {
              lastTextNode.value = _.truncate(lastTextNode.value, {
                length: pruneLength,
                omission: `…`,
              })
            }
            return hastToHTML(excerptAST, {
              allowDangerousHTML: true,
            })
          }
          if (markdownNode.excerpt) {
            return Promise.resolve(markdownNode.excerpt)
          }
          return getAST(markdownNode).then(ast => {
            const excerptNodes = []
            visit(ast, node => {
              if (node.type === `text` || node.type === `inlineCode`) {
                excerptNodes.push(node.value)
              }
              return
            })
            if (!truncate) {
              return prune(excerptNodes.join(` `), pruneLength, `…`)
            }
            return _.truncate(excerptNodes.join(` `), {
              length: pruneLength,
              omission: `…`,
            })
          })
        },
      },
      headings: {
        type: new GraphQLList(HeadingType),
        args: {
          depth: {
            type: HeadingLevels,
          },
        },
        resolve(markdownNode, { depth }) {
          return getHeadings(markdownNode).then(headings => {
            if (typeof depth === `number`) {
              headings = headings.filter(heading => heading.depth === depth)
            }
            return headings
          })
        },
      },
      timeToRead: {
        type: GraphQLInt,
        resolve(markdownNode) {
          return getHTML(markdownNode).then(html => {
            let timeToRead = 0
            const pureText = sanitizeHTML(html, { allowTags: [] })
            const avgWPM = 265
            const wordCount = _.words(pureText).length
            timeToRead = Math.round(wordCount / avgWPM)
            if (timeToRead === 0) {
              timeToRead = 1
            }
            return timeToRead
          })
        },
      },
      tableOfContents: {
        type: GraphQLString,
        args: {
          pathToSlugField: {
            type: GraphQLString,
            defaultValue: `fields.slug`,
          },
          maxDepth: {
            type: GraphQLInt,
          },
          heading: {
            type: GraphQLString,
          },
        },
        resolve(markdownNode, args) {
          return getTableOfContents(markdownNode, args)
        },
      },
      // TODO add support for non-latin languages https://github.com/wooorm/remark/issues/251#issuecomment-296731071
      wordCount: {
        type: new GraphQLObjectType({
          name: `wordCount`,
          fields: {
            paragraphs: {
              type: GraphQLInt,
            },
            sentences: {
              type: GraphQLInt,
            },
            words: {
              type: GraphQLInt,
            },
          },
        }),
        resolve(markdownNode) {
          let counts = {}

          unified()
            .use(parse)
            .use(
              remark2retext,
              unified()
                .use(english)
                .use(count)
            )
            .use(stringify)
            .processSync(markdownNode.internal.content)

          return {
            paragraphs: counts.ParagraphNode,
            sentences: counts.SentenceNode,
            words: counts.WordNode,
          }

          function count() {
            return counter
            function counter(tree) {
              visit(tree, visitor)
              function visitor(node) {
                counts[node.type] = (counts[node.type] || 0) + 1
              }
            }
          }
        },
      },
    })
  })
}
