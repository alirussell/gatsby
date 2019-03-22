/* @flow */

const _ = require(`lodash`)
const slash = require(`slash`)

const fs = require(`fs-extra`)
const md5File = require(`md5-file/promise`)
const crypto = require(`crypto`)
const del = require(`del`)
const copyGatsbyFiles = require(`./copy-gatsby-files`)

const path = require(`path`)
const convertHrtime = require(`convert-hrtime`)
const Promise = require(`bluebird`)

const apiRunnerNode = require(`../utils/api-runner-node`)
const getBrowserslist = require(`../utils/browserslist`)
const { graphql } = require(`graphql`)
const { store, emitter, flags } = require(`../redux`)
const loadPlugins = require(`./load-plugins`)
const loadThemes = require(`./load-themes`)
const { boundActionCreators } = require(`../redux/actions`)
const { deletePage } = boundActionCreators
const report = require(`gatsby-cli/lib/reporter`)
const getConfigFile = require(`./get-config-file`)
const tracer = require(`opentracing`).globalTracer()
const preferDefault = require(`./prefer-default`)
const nodeTracking = require(`../db/node-tracking`)
const pageData = require(`../utils/page-data`)
const withResolverContext = require(`../schema/context`)
require(`../db`).startAutosave()

// Show stack trace on unhandled promises.
process.on(`unhandledRejection`, (reason, p) => {
  report.panic(reason)
})

const {
  extractQueries,
} = require(`../internal-plugins/query-runner/query-watcher`)
const {
  runInitialQueries,
  runQueriesForPathnames,
} = require(`../internal-plugins/query-runner/page-query-runner`)
const queryQueue = require(`../internal-plugins/query-runner/query-queue`)
const { writePages } = require(`../internal-plugins/query-runner/pages-writer`)
const redirectsWriter = require(`../internal-plugins/query-runner/redirects-writer`)

const queryCompiler = require(`../internal-plugins/query-runner/query-compiler`)
  .default

// Override console.log to add the source file + line number.
// Useful for debugging if you lose a console.log somewhere.
// Otherwise leave commented out.
// require(`./log-line-function`)

type BootstrapArgs = {
  directory: string,
  prefixPaths?: boolean,
  parentSpan: Object,
}

function getProgram(args) {
  // TODO come up with better test if programs has run already
  if (!_.isEmpty(store.getState().program.browserslist)) {
    return store.getState().program
  } else {
    const directory = slash(args.directory)
    const program = {
      ...args,
      browserslist: getBrowserslist(directory),
      // Fix program directory path for windows env.
      directory,
    }
    store.dispatch({
      type: `SET_PROGRAM`,
      payload: program,
    })
    return program
  }
}

async function initConfig({ bootstrapSpan, program }) {
  if (!_.isEmpty(store.getState().config)) {
    return store.getState().config
  } else {
    // Try opening the site's gatsby-config.js file.
    let activity = report.activityTimer(`open and validate gatsby-configs`, {
      parentSpan: bootstrapSpan,
    })
    activity.start()
    let config = await preferDefault(
      getConfigFile(program.directory, `gatsby-config`)
    )

    // theme gatsby configs can be functions or objects
    if (config && config.__experimentalThemes) {
      const themes = await loadThemes(config)
      config = themes.config

      store.dispatch({
        type: `SET_RESOLVED_THEMES`,
        payload: themes.themes,
      })
    }

    if (config && config.polyfill) {
      report.warn(
        `Support for custom Promise polyfills has been removed in Gatsby v2. We only support Babel 7's new automatic polyfilling behavior.`
      )
    }

    store.dispatch({
      type: `SET_SITE_CONFIG`,
      payload: config,
    })

    activity.end()
    return config
  }
}

async function initLoki({ bootstrapSpan, cacheDirectory }) {
  const activity = report.activityTimer(`start nodes db`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  const loki = require(`../db/loki`)
  const dbSaveFile = `${cacheDirectory}/loki/loki.db`
  try {
    await loki.start({
      saveFile: dbSaveFile,
    })
  } catch (e) {
    report.error(
      `Error starting DB. Perhaps try deleting ${path.dirname(dbSaveFile)}`
    )
  }
  activity.end()
}

async function deleteHtmlCss({ bootstrapSpan }) {
  // During builds, delete html and css files from the public directory as we don't want
  // deleted pages and styles from previous builds to stick around.
  if (process.env.NODE_ENV === `production`) {
    const activity = report.activityTimer(
      `delete html and css files from previous builds`,
      {
        parentSpan: bootstrapSpan,
      }
    )
    activity.start()
    await del([
      `public/*.{html,css}`,
      `public/**/*.{html,css}`,
      `!public/static`,
      `!public/static/**/*.{html,css}`,
    ])
    activity.end()
  }
}

async function getPluginConfigHash({ program, flattenedPlugins }) {
  const pluginVersions = flattenedPlugins.map(p => p.version)
  const hashes = await Promise.all([
    md5File(`package.json`),
    Promise.resolve(
      md5File(`${program.directory}/gatsby-config.js`).catch(() => {})
    ), // ignore as this file isn't required),
    Promise.resolve(
      md5File(`${program.directory}/gatsby-node.js`).catch(() => {})
    ), // ignore as this file isn't required),
  ])
  return crypto
    .createHash(`md5`)
    .update(JSON.stringify(pluginVersions.concat(hashes)))
    .digest(`hex`)
}

async function initCache(context) {
  const { cacheDirectory } = context
  const activity = report.activityTimer(`initialize cache`)
  activity.start()

  // Check if any plugins have been updated since our last run. If so
  // we delete the cache is there's likely been changes
  // since the previous run.
  //
  // We do this by creating a hash of all the version numbers of installed
  // plugins, the site's package.json, gatsby-config.js, and gatsby-node.js.
  // The last, gatsby-node.js, is important as many gatsby sites put important
  // logic in there e.g. generating slugs for custom pages.
  const pluginsHash = await getPluginConfigHash(context)
  let state = store.getState()
  const oldPluginsHash = state && state.status ? state.status.PLUGINS_HASH : ``
  // Check if anything has changed. If it has, delete the site's .cache
  // directory and tell reducers to empty themselves.
  //
  // Also if the hash isn't there, then delete things just in case something
  // is weird.
  if (oldPluginsHash && pluginsHash !== oldPluginsHash) {
    report.info(report.stripIndent`
      One or more of your plugins have changed since the last time you ran Gatsby. As
      a precaution, we're deleting your site's cache to ensure there's not any stale
      data
    `)
  }
  if (!oldPluginsHash || pluginsHash !== oldPluginsHash) {
    flags.srcDirty = true
    try {
      // Attempt to empty dir if remove fails,
      // like when directory is mount point
      await fs.remove(cacheDirectory).catch(() => fs.emptyDir(cacheDirectory))
    } catch (e) {
      report.error(`Failed to remove .cache files.`, e)
    }
    // Tell reducers to delete their data (the store will already have
    // been loaded from the file system cache).
    store.dispatch({
      type: `DELETE_CACHE`,
    })
  }

  // Update the store with the new plugins hash.
  store.dispatch({
    type: `UPDATE_PLUGINS_HASH`,
    payload: pluginsHash,
  })

  // Now that we know the .cache directory is safe, initialize the cache
  // directory.
  await fs.ensureDir(cacheDirectory)

  activity.end()
}

async function setExtensions({ bootstrapSpan }) {
  if (!_.isEmpty(store.getState().program.extensions)) {
    return
  }
  // Collect resolvable extensions and attach to program. This is used
  // by plugin-page-creator (in create pages statefully phase). Also used in webpack config
  const extensions = [`.mjs`, `.js`, `.jsx`, `.wasm`, `.json`]
  // Change to this being an action and plugins implement `onPreBootstrap`
  // for adding extensions.
  const apiResults = await apiRunnerNode(`resolvableExtensions`, {
    traceId: `initial-resolvableExtensions`,
    parentSpan: bootstrapSpan,
  })

  store.dispatch({
    type: `SET_PROGRAM_EXTENSIONS`,
    payload: _.flattenDeep([extensions, apiResults]),
  })
}

async function createPages({ bootstrapSpan, graphqlRunner }) {
  // Collect pages.
  let activity = report.activityTimer(`createPages`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunnerNode(`createPages`, {
    graphql: graphqlRunner,
    traceId: `initial-createPages`,
    waitForCascadingActions: true,
    parentSpan: activity.span,
  })
  activity.end()

  // A variant on createPages for plugins that want to
  // have full control over adding/removing pages. The normal
  // "createPages" API is called every time (during development)
  // that data changes.
  activity = report.activityTimer(`createPagesStatefully`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunnerNode(`createPagesStatefully`, {
    graphql: graphqlRunner,
    traceId: `initial-createPagesStatefully`,
    waitForCascadingActions: true,
    parentSpan: activity.span,
  })
  activity.end()

  const state = store.getState()
  const touched = state.pagesTouched

  for (const [path, page] of state.pages) {
    if (!touched.has(path)) {
      console.log(`found stale page`, page.path)
      deletePage(page)
    }
  }
}

async function runBootstrapQueries({ bootstrapSpan, graphqlRunner }) {
  // Extract queries
  let activity = report.activityTimer(`extract queries from components`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await extractQueries()
  activity.end()

  // Start the createPages hot reloader.
  if (process.env.NODE_ENV !== `production`) {
    require(`./page-hot-reloader`)(graphqlRunner)
  }

  for (const [path] of store.getState().pages) {
    pageData.getQueue().push({ path })
  }

  // Run queries
  activity = report.activityTimer(`run graphql queries`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  const startQueries = process.hrtime()
  queryQueue.on(`task_finish`, () => {
    const stats = queryQueue.getStats()
    activity.setStatus(
      `${stats.total}/${stats.peak} ${(
        stats.total / convertHrtime(process.hrtime(startQueries)).seconds
      ).toFixed(2)} queries/second`
    )
  })
  await runInitialQueries(activity)
  activity.end()
}

function saveQuery(components, component, query) {
  if (query.isStaticQuery) {
    boundActionCreators.replaceStaticQuery({
      name: query.name,
      componentPath: query.path,
      id: query.jsonName,
      jsonName: query.jsonName,
      query: query.text,
      hash: query.hash,
    })
    boundActionCreators.deleteComponentsDependencies([query.jsonName])
  } else if (components.has(component)) {
    boundActionCreators.replaceComponentQuery({
      query: query.text,
      componentPath: component,
    })
  }
}

async function runIncrementalQueries({ bootstrapSpan }) {
  // TODO clearInactiveComponents
  if (flags.schema) {
    console.log(`recompiling queries because schema changed`)
    // Extract queries
    let activity = report.activityTimer(`extract queries from components`, {
      parentSpan: bootstrapSpan,
    })
    activity.start()
    const queries = await queryCompiler()
    const components = new Map(store.getState().components)
    queries.forEach((query, component) =>
      saveQuery(components, component, query)
    )
    activity.end()
    const pages = store.getState().pages
    for (const path of pages) {
      flags.queryJob(path)
    }
    for (const jsonName of store.getState().staticQueryComponents) {
      flags.queryJob(jsonName)
    }
  }

  const state = store.getState()

  flags.nodes.forEach(nodeId => {
    const queryIds = state.componentDataDependencies.nodes[nodeId] || []
    queryIds.forEach(queryId => {
      flags.queryJob(queryId)
    })
  })

  flags.nodeTypeCollections.forEach(type => {
    const queries = state.componentDataDependencies.connections[type] || []
    queries.forEach(queryId => {
      flags.queryJob(queryId)
    })
  })

  // All created/changed pages need to be rerun
  flags.pages.forEach(path => {
    flags.queryJob(path)
  })

  // Run queries
  let activity = report.activityTimer(`run graphql queries`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  const startQueries = process.hrtime()
  queryQueue.on(`task_finish`, () => {
    const stats = queryQueue.getStats()
    activity.setStatus(
      `${stats.total}/${stats.peak} ${(
        stats.total / convertHrtime(process.hrtime(startQueries)).seconds
      ).toFixed(2)} queries/second`
    )
  })
  await runQueriesForPathnames(Array.from(flags.queryJobs))
  activity.end()
}

async function writeRedirects({ bootstrapSpan }) {
  // Write out redirects.
  const activity = report.activityTimer(`write out redirect data`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await redirectsWriter.writeRedirects()
  activity.end()
}

const checkJobsDone = resolve => {
  if (store.getState().jobs.active.length === 0) {
    resolve()
  }
}

const debouncedCheckJobsDone = _.debounce(checkJobsDone, 100)

function waitJobsFinished() {
  return new Promise((resolve, reject) => {
    checkJobsDone(resolve)
    emitter.on(`END_JOB`, () => debouncedCheckJobsDone(resolve))
  })
}

module.exports = async (args: BootstrapArgs) => {
  // Same as incremental from here

  const spanArgs = args.parentSpan ? { childOf: args.parentSpan } : {}
  const bootstrapSpan = tracer.startSpan(`bootstrap`, spanArgs)
  const program = getProgram(args)
  const cacheDirectory = `${program.directory}/.cache`

  const bootstrapContext = {
    cacheDirectory,
    bootstrapSpan,
    program,
  }

  const config = await initConfig(bootstrapContext)

  pageData.initQueue({ program, store, flags })

  // Start plugin runner which listens to the store
  // and invokes Gatsby API based on actions.
  require(`../redux/plugin-runner`)

  let activity = report.activityTimer(`load plugins`)
  activity.start()
  const flattenedPlugins = await loadPlugins(config)
  bootstrapContext.flattenedPlugins = flattenedPlugins
  activity.end()

  // onPreInit
  activity = report.activityTimer(`onPreInit`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunnerNode(`onPreInit`, { parentSpan: activity.span })
  activity.end()

  await initCache(bootstrapContext, flattenedPlugins)

  // Ensure the public/static directory
  await fs.ensureDir(`${program.directory}/public/static`)

  await copyGatsbyFiles(bootstrapContext)

  await setExtensions(bootstrapContext)

  /**
   * Start the main bootstrap processes.
   */

  if (process.env.GATSBY_DB_NODES === `loki`) {
    await initLoki(bootstrapContext)
  }

  // By now, our nodes database has been loaded, so ensure that we
  // have tracked all inline objects
  nodeTracking.trackDbNodes()

  // onPreBootstrap
  activity = report.activityTimer(`onPreBootstrap`)
  activity.start()
  await apiRunnerNode(`onPreBootstrap`)
  activity.end()

  // Source nodes
  activity = report.activityTimer(`source and transform nodes`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await require(`../utils/source-nodes`)({ parentSpan: activity.span })
  activity.end()

  // Create Schema.
  activity = report.activityTimer(`building schema`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await require(`../schema`).build({ parentSpan: activity.span })
  activity.end()

  const graphqlRunner = (query, context = {}) => {
    const schema = store.getState().schema
    return graphql(
      schema,
      query,
      context,
      withResolverContext(context, schema),
      context
    )
  }

  const existingPages = _.clone(store.getState().pages)

  await createPages({ activity, bootstrapSpan, graphqlRunner })

  activity = report.activityTimer(`onPreExtractQueries`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunnerNode(`onPreExtractQueries`, { parentSpan: activity.span })
  activity.end()

  // Update Schema for SitePage.
  activity = report.activityTimer(`update schema`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await require(`../schema`).rebuildWithSitePage({ parentSpan: activity.span })
  activity.end()

  const eqPages = (page1, page2) => {
    const changeKeys = [`component`, `context`, `matchPath`]
    return (
      page1 &&
      page2 &&
      _.isEqual(_.pick(page1, changeKeys), _.pick(page2, changeKeys))
    )
  }

  // Check if pages changes actually occurred
  const flaggedPaths = flags.pages
  flaggedPaths.forEach(path => {
    if (eqPages(existingPages.get(path), store.getState().pages.get(path))) {
      flags.pages.delete(path)
    }
  })
  for (const path of flags.pages) {
    pageData.getQueue().push({ path })
  }

  if (flags.srcDirty) {
    await runBootstrapQueries({ bootstrapSpan, graphqlRunner })
  } else {
    await runIncrementalQueries({ bootstrapSpan })
  }
  // Write out files.
  activity = report.activityTimer(`write out page data`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  try {
    await writePages()
  } catch (err) {
    report.panic(`Failed to write out page data`, err)
  }
  activity.end()

  await writeRedirects({ activity, bootstrapSpan })
  // End different

  // Wait for jobs to finish
  await waitJobsFinished()

  // onPostBootstrap
  activity = report.activityTimer(`onPostBootstrap`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunnerNode(`onPostBootstrap`, { parentSpan: activity.span })
  activity.end()

  bootstrapSpan.finish()

  report.log(``)
  report.info(`bootstrap finished - ${process.uptime()} s`)
  report.log(``)
  emitter.emit(`BOOTSTRAP_FINISHED`)

  return { graphqlRunner }
}
