// @flow

import type { QueryJob } from "../query-runner"

/**
 * Jobs of this module
 * - Ensure on bootstrap that all invalid page queries are run and report
 *   when this is done
 * - Watch for when a page's query is invalidated and re-run it.
 */

const _ = require(`lodash`)

const queue = require(`./query-queue`)
const { store, emitter } = require(`../redux`)

let queuedDirtyActions = []

let active = false
let running = false

const extractedQueryIds = new Set()
const enqueueExtractedQueryId = pathname => {
  extractedQueryIds.add(pathname)
}

const popNodeAndDepQueries = state => {
  const nodeQueries = popNodeQueries({ state })

  const noDepQueries = findIdsWithoutDataDependencies(state)

  return _.uniq([...nodeQueries, ...noDepQueries])
}

const popExtractedQueries = () => {
  const queries = [...extractedQueryIds]
  extractedQueryIds.clear()
  return queries
}

/**
 * Calculates the set of dirty query IDs (page.paths, or
 * staticQuery.hash's). These are queries that:
 *
 * - depend on nodes or node collections (via
 *   `actions.createPageDependency`) that have changed.
 * - do NOT have node dependencies. Since all queries should return
 *   data, then this implies that node dependencies have not been
 *   tracked, and therefore these queries haven't been run before
 * - have been recently extracted (see `./query-watcher.js`)
 *
 * Note, this function pops queries off internal queues, so it's up
 * to the caller to reference the results
 */

const calcDirtyQueryIds = state =>
  _.union(popNodeAndDepQueries(state), popExtractedQueries())

/**
 * Same as `calcDirtyQueryIds`, except that we only include extracted
 * queries that depend on nodes or haven't been run yet. We do this
 * because the page component reducer/machine always enqueues
 * extractedQueryIds but during bootstrap we may not want to run those
 * page queries if their data hasn't changed since the last time we
 * ran Gatsby.
 */
const calcBootstrapDirtyQueryIds = state => {
  const nodeAndNoDepQueries = popNodeAndDepQueries(state)

  const extractedQueriesThatNeedRunning = _.intersection(
    popExtractedQueries(),
    nodeAndNoDepQueries
  )
  return _.union(extractedQueriesThatNeedRunning, nodeAndNoDepQueries)
}

const runQueries = async () => {
  if (!active) {
    return
  }
  const queryIds = calcDirtyQueryIds(store.getState())
  await runQueriesForQueryIds(queryIds)
}

// Do initial run of graphql queries during bootstrap.
// Afterwards we listen "API_RUNNING_QUEUE_EMPTY" and check
// for dirty nodes before running queries.
const runInitialQueries = async () => {
  active = true
  const queryIds = calcBootstrapDirtyQueryIds(store.getState())
  await runQueriesForQueryIds(queryIds)
  return
}

emitter.on(`CREATE_NODE`, action => {
  queuedDirtyActions.push(action)
})

emitter.on(`DELETE_NODE`, action => {
  queuedDirtyActions.push({ payload: action.payload })
})

const runQueuedActions = async () => {
  if (active && !running) {
    try {
      running = true
      await runQueries()
    } finally {
      running = false
      if (queuedDirtyActions.length > 0) {
        runQueuedActions()
      }
    }
  }
}

// Wait until all plugins have finished running (e.g. various
// transformer plugins) before running queries so we don't
// query things in a 1/2 finished state.
emitter.on(`API_RUNNING_QUEUE_EMPTY`, runQueuedActions)

let seenIdsWithoutDataDependencies = []

// Remove pages from seenIdsWithoutDataDependencies when they're deleted
// so their query will be run again if they're created again.
emitter.on(`DELETE_PAGE`, action => {
  seenIdsWithoutDataDependencies = seenIdsWithoutDataDependencies.filter(
    p => p !== action.payload.path
  )
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

const runQueriesForQueryIds = pathnames => {
  const staticQueries = pathnames.filter(p => p.slice(0, 4) === `sq--`)
  const pageQueries = pathnames.filter(p => p.slice(0, 4) !== `sq--`)
  const state = store.getState()

  staticQueries.forEach(id => {
    const staticQueryComponent = store.getState().staticQueryComponents.get(id)
    const queryJob: QueryJob = {
      id: staticQueryComponent.hash,
      hash: staticQueryComponent.hash,
      jsonName: staticQueryComponent.jsonName,
      query: staticQueryComponent.query,
      componentPath: staticQueryComponent.componentPath,
      context: { path: staticQueryComponent.jsonName },
    }
    queue.push(queryJob)
  })

  const pages = state.pages
  let didNotQueueItems = true
  pageQueries.forEach(id => {
    const page = pages.get(id)
    if (page) {
      didNotQueueItems = false
      queue.push(
        ({
          id: page.path,
          jsonName: page.jsonName,
          query: store.getState().components.get(page.componentPath).query,
          isPage: true,
          componentPath: page.componentPath,
          context: {
            ...page,
            ...page.context,
          },
        }: QueryJob)
      )
    }
  })

  if (didNotQueueItems || !pathnames || pathnames.length === 0) {
    return Promise.resolve()
  }

  return new Promise(resolve => {
    const onDrain = () => {
      queue.removeListener(`drain`, onDrain)
      resolve()
    }
    queue.on(`drain`, onDrain)
  })
}

const popNodeQueries = ({ state }) => {
  const actions = _.uniq(queuedDirtyActions, a => a.payload.id)

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
  queuedDirtyActions = []
  return uniqDirties
}

module.exports = {
  runQueries,
  runInitialQueries,
  enqueueExtractedQueryId,
  runQueuedActions,
}
