const _ = require(`lodash`)
const { store, emitter } = require(`../../redux`)
const queryQueue = require(`./query-queue`)
const convertHrtime = require(`convert-hrtime`)

let seenIdsWithoutDataDependencies = []
let queuedDirtyActions = []
const dirtyQueryIds = new Set()

// Remove pages from seenIdsWithoutDataDependencies when they're deleted
// so their query will be run again if they're created again.
emitter.on(`DELETE_PAGE`, action => {
  seenIdsWithoutDataDependencies = seenIdsWithoutDataDependencies.filter(
    p => p !== action.payload.path
  )
})

emitter.on(`CREATE_NODE`, action => {
  queuedDirtyActions.push(action)
})

emitter.on(`DELETE_NODE`, action => {
  queuedDirtyActions.push({ payload: action.payload })
})

const findIdsWithoutDataDependencies = state => {
  const allTrackedIds = _.uniq(
    _.flatten(
      _.concat(
        _.values(state.componentDataDependencies.nodes),
        _.values(state.componentDataDependencies.connections)
      )
    )
  )

  // Get list of paths not already tracked and run the queries for these
  // paths.
  const notTrackedIds = _.difference(
    [
      ...Array.from(state.pages.values(), p => p.path),
      ...[...state.staticQueryComponents.values()].map(c => c.jsonName),
    ],
    [...allTrackedIds, ...seenIdsWithoutDataDependencies]
  )

  // Add new IDs to our seen array so we don't keep trying to run queries for them.
  // Pages without queries can't be tracked.
  seenIdsWithoutDataDependencies = _.uniq([
    ...notTrackedIds,
    ...seenIdsWithoutDataDependencies,
  ])

  return notTrackedIds
}

const findDirtyIds = (actions, { state }) => {
  const uniqDirties = _.uniq(
    actions.reduce((dirtyIds, action) => {
      const node = action.payload

      if (!node || !node.id || !node.internal.type) return dirtyIds

      // Find components that depend on this node so are now dirty.
      dirtyIds = dirtyIds.concat(state.componentDataDependencies.nodes[node.id])

      // Find connections that depend on this node so are now invalid.
      dirtyIds = dirtyIds.concat(
        state.componentDataDependencies.connections[node.internal.type]
      )

      return _.compact(dirtyIds)
    }, [])
  )
  return uniqDirties
}

const calcDirtyQueryIds = state => {
  queuedDirtyActions = _.uniq(queuedDirtyActions, a => a.payload.id)
  const dirtyIds = findDirtyIds(queuedDirtyActions, { state })
  queuedDirtyActions = []

  const cleanIds = findIdsWithoutDataDependencies(state)

  // Construct paths for all queries to run
  let pathnamesToRun = _.uniq([...dirtyIds, ...cleanIds])

  // If this is the initial run, remove pathnames from `dirtyQueryIds`
  // if they're also not in the dirtyIds or cleanIds.
  //
  // We do this because the page component reducer/machine always
  // adds pages to dirtyQueryIds but during bootstrap
  // we may not want to run those page queries if their data hasn't
  // changed since the last time we ran Gatsby.
  let diffedPathnames = [...dirtyQueryIds]
  diffedPathnames = _.intersection([...dirtyQueryIds], pathnamesToRun)
  // Combine.
  pathnamesToRun = _.union(diffedPathnames, pathnamesToRun)

  dirtyQueryIds.clear()

  return pathnamesToRun
}

// TODO refactor this and above
const calcFollowupDirtyQueryIds = state => {
  queuedDirtyActions = _.uniq(queuedDirtyActions, a => a.payload.id)
  const dirtyIds = findDirtyIds(queuedDirtyActions)
  queuedDirtyActions = []

  const cleanIds = findIdsWithoutDataDependencies(state)

  // Construct paths for all queries to run
  let pathnamesToRun = _.uniq([...dirtyIds, ...cleanIds])

  // If this is the initial run, remove pathnames from `dirtyQueryIds`
  // if they're also not in the dirtyIds or cleanIds.
  //
  // We do this because the page component reducer/machine always
  // adds pages to dirtyQueryIds but during bootstrap
  // we may not want to run those page queries if their data hasn't
  // changed since the last time we ran Gatsby.
  let diffedPathnames = [...dirtyQueryIds]

  // Combine.
  pathnamesToRun = _.union(diffedPathnames, pathnamesToRun)

  dirtyQueryIds.clear()

  return pathnamesToRun
}

const categorizeQueryIds = queryIds => {
  const grouped = _.groupBy(queryIds, p => p.slice(0, 4) === `sq--`)
  return {
    staticQueryIds: grouped[true] || [],
    pageQueryIds: grouped[false] || [],
  }
}

const staticQueryToQueryJob = component => {
  const { hash, jsonName, query, componentPath } = component
  return {
    id: hash,
    hash,
    jsonName,
    query,
    componentPath,
    context: { path: jsonName },
  }
}

const staticQueryMaker = state => queryId =>
  staticQueryToQueryJob(state.staticQueryComponents.get(queryId))

const makePageQueryJob = (page, component) => {
  const { path, jsonName, componentPath, context } = page
  const { query } = component
  return {
    id: path,
    jsonName: jsonName,
    query,
    isPage: true,
    componentPath,
    context: {
      ...page,
      ...context,
    },
  }
}

const pageQueryMaker = state => queryId => {
  const page = state.pages.get(queryId)
  const component = state.components.get(page.componentPath)
  return makePageQueryJob(page, component)
}

const processQueries = async (queryIds, { activity, toQueryJob }) => {
  if (queryIds.length > 0) {
    const startQueries = process.hrtime()

    const queue = queryQueue.create()
    queue.on(`task_finish`, () => {
      const stats = queue.getStats()
      activity.setStatus(
        `${stats.total}/${stats.peak} ${(
          stats.total / convertHrtime(process.hrtime(startQueries)).seconds
        ).toFixed(2)} queries/second`
      )
    })
    const drainedPromise = new Promise(resolve => {
      queue.once(`drain`, resolve)
    })

    queryIds.map(toQueryJob).forEach(queryJob => {
      queue.push(queryJob)
    })
    await drainedPromise
  }
}

const processStaticQueries = async (queryIds, { activity, state }) => {
  const toQueryJob = staticQueryMaker(state)
  await processQueries(queryIds, { toQueryJob, activity })
}

const processPageQueries = async (queryIds, { activity, state }) => {
  const toQueryJob = pageQueryMaker(state)
  await processQueries(queryIds, { toQueryJob, activity })
}

const startDaemon = () => {
  const queue = queryQueue.create()

  const runQueuedActions = () => {
    const state = store.getState()
    const makeStaticQuery = staticQueryMaker(state)
    const makePageQuery = pageQueryMaker(state)
    const dirtyQueryIds = calcFollowupDirtyQueryIds(state)
    const { staticQueryIds, pageQueryIds } = categorizeQueryIds(dirtyQueryIds)
    staticQueryIds
      .map(makeStaticQuery)
      .concat(pageQueryIds.map(makePageQuery))
      .forEach(queryJob => {
        queue.push(queryJob)
      })
  }
  runQueuedActions()
  // Wait until all plugins have finished running (e.g. various
  // transformer plugins) before running queries so we don't
  // query things in a 1/2 finished state.
  emitter.on(`API_RUNNING_QUEUE_EMPTY`, runQueuedActions)
  emitter.on(`QUERY_RUNNER_QUERIES_ENQUEUED`, runQueuedActions)
}

const enqueueQueryId = queryId => {
  dirtyQueryIds.add(queryId)
}

const runQueries = () => {
  emitter.emit(`QUERY_RUNNER_QUERIES_ENQUEUED`)
}

module.exports = {
  enqueueQueryId,
  processStaticQueries,
  processPageQueries,
  runQueries,
  calcDirtyQueryIds,
  categorizeQueryIds,
  staticQueryMaker,
  pageQueryMaker,
  startDaemon,
}
