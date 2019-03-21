/* @flow */

const _ = require(`lodash`)
const slash = require(`slash`)

const path = require(`path`)
const convertHrtime = require(`convert-hrtime`)
const Promise = require(`bluebird`)

const apiRunner = require(`../utils/api-runner-node`)
const getBrowserslist = require(`../utils/browserslist`)
const { graphql } = require(`graphql`)
const { store, emitter, flags } = require(`../redux`)
const loadPlugins = require(`../bootstrap/load-plugins`)
const loadThemes = require(`../bootstrap/load-themes`)
const { boundActionCreators } = require(`../redux/actions`)
const { deletePage } = boundActionCreators
const report = require(`gatsby-cli/lib/reporter`)
const getConfigFile = require(`../bootstrap/get-config-file`)
const tracer = require(`opentracing`).globalTracer()
const preferDefault = require(`../bootstrap/prefer-default`)

const nodeTracking = require(`../db/node-tracking`)
const pageData = require(`../utils/page-data`)
const withResolverContext = require(`../schema/context`)
require(`../db`).startAutosave()

const buildProductionBundle = require(`../commands/build-javascript`)
const buildHtml = require(`../commands/build-html`)

// Show stack trace on unhandled promises.
process.on(`unhandledRejection`, (reason, p) => {
  report.panic(reason)
})

const {
  runQueriesForPathnames,
} = require(`../internal-plugins/query-runner/page-query-runner`)
const queryQueue = require(`../internal-plugins/query-runner/query-queue`)
const pagesWriter = require(`../internal-plugins/query-runner/pages-writer`)
const redirectsWriter = require(`../internal-plugins/query-runner/redirects-writer`)

const queryCompiler = require(`../internal-plugins/query-runner/query-compiler`)
  .default

type BootstrapArgs = {
  directory: string,
  prefixPaths?: boolean,
  parentSpan: Object,
}

function getProgram(args) {
  if (store.getState().program) {
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
  if (store.getState().config) {
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

async function createPages({ bootstrapSpan, graphqlRunner }) {
  // Collect pages.
  let activity = report.activityTimer(`createPages`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunner(`createPages`, {
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
  await apiRunner(`createPagesStatefully`, {
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

  // TODO double check rerun schema stuff
}

function shouldRecompileQueries() {
  return flags.schema
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

async function runQueries({ bootstrapSpan }) {
  // TODO clearInactiveComponents
  if (shouldRecompileQueries()) {
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
  flags.nodeTypeCollections.forEach(type => {
    const queries = state.depGraph.queryDependsOnNodeCollection[type] || []
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

const checkJobsDone = _.debounce(resolve => {
  if (store.getTtate.jobs.active.length === 0) {
    resolve()
  }
}, 100)

function waitJobsFinished() {
  return new Promise((resolve, reject) => {
    if (store.getState().jobs.active.length === 0) {
      resolve()
    }
    emitter.on(`END_JOB`, () => checkJobsDone(resolve))
  })
}

const shouldbuildProductionApp = () =>
  flags.matchPathsChanged || flags.staticQueryChanged || flags.redirectsChanged

function reportFailure(msg, err) {
  report.log(``)
  report.panic(msg, err)
}

async function buildProductionApp({ bootstrapSpan, program }) {
  const activity = report.activityTimer(
    `Building production JavaScript and CSS bundles`,
    { parentSpan: bootstrapSpan }
  )
  activity.start()
  await buildProductionBundle(program).catch(err => {
    reportFailure(`Generating JavaScript bundles failed`, err)
  })
  activity.end()
}

async function build(args: BootstrapArgs) {
  console.log(`INCREMENTAL`)

  // Same as Full build from here

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
  await apiRunner(`onPreInit`, { parentSpan: activity.span })
  activity.end()

  // full build inits the cache here. We don't need to since no code
  // has changed

  if (process.env.GATSBY_DB_NODES === `loki`) {
    initLoki(bootstrapContext)
  }

  // By now, our nodes database has been loaded, so ensure that we
  // have tracked all inline objects
  nodeTracking.trackDbNodes()

  // onPreBootstrap
  activity = report.activityTimer(`onPreBootstrap`)
  activity.start()
  await apiRunner(`onPreBootstrap`)
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

  // Different
  const existingPages = _.clone(store.getState().pages)
  // end Different

  await createPages({ activity, bootstrapSpan, graphqlRunner })

  activity = report.activityTimer(`onPreExtractQueries`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunner(`onPreExtractQueries`, { parentSpan: activity.span })
  activity.end()

  // Update Schema for SitePage.
  activity = report.activityTimer(`update schema`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await require(`../schema`).rebuildWithSitePage({ parentSpan: activity.span })
  activity.end()

  // Different
  const eqPages = (page1, page2) => {
    const changeKeys = [`component`, `context`, `matchPath`]
    return (
      page1 &&
      page2 &&
      _.isEqual(_.pick(page1, changeKeys), _.pick(page2, changeKeys))
    )
  }

  const flaggedPaths = flags.pages
  flaggedPaths.forEach(path => {
    if (eqPages(existingPages.get(path), store.getState().pages.get(path))) {
      flags.pages.delete(path)
    }
  })
  for (const path of flags.pages) {
    pageData.getQueue().push({ path })
  }
  // End different

  await runQueries({ activity, bootstrapSpan })

  await writeRedirects({ activity, bootstrapSpan })

  // Write out matchPaths.json
  activity = report.activityTimer(`write out pages`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await pagesWriter.writePages()
  activity.end()

  // Wait for jobs to finish
  await waitJobsFinished()

  // onPostBootstrap
  activity = report.activityTimer(`onPostBootstrap`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunner(`onPostBootstrap`, { parentSpan: activity.span })
  activity.end()

  bootstrapSpan.finish()

  report.log(``)
  report.info(`bootstrap finished - ${process.uptime()} s`)
  report.log(``)
  emitter.emit(`BOOTSTRAP_FINISHED`)

  await apiRunner(`onPreBuild`, {
    graphql: graphqlRunner,
    parentSpan: bootstrapSpan,
  })

  // TODO build.copyStaticDir()?

  if (shouldbuildProductionApp()) {
    await buildProductionApp(bootstrapContext)
  }

  if (flags.renderPageDirty) {
    activity = report.activityTimer(`build render-page.js`, {
      parentSpan: bootstrapSpan,
    })
    activity.start()
    await buildHtml.buildRenderPage()
    activity.end()
  }

  activity = report.activityTimer(`write out page html`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await buildHtml.buildDirtyPages(activity)
  activity.end()
}

module.exports = build
