// @flow

import { graphql as graphqlFunction } from "graphql"
const invariant = require(`invariant`)
const fs = require(`fs-extra`)
const report = require(`gatsby-cli/lib/reporter`)
const websocketManager = require(`../../utils/websocket-manager`)

const path = require(`path`)
const { store } = require(`../../redux`)
const withResolverContext = require(`../../schema/context`)
const { formatErrorDetails } = require(`./utils`)
const debug = require(`debug`)(`gatsby:query-runner`)

type QueryJob = {
  id: string,
  hash?: string,
  jsonName: string,
  query: string,
  componentPath: string,
  context: Object,
  isPage: Boolean,
}

// Run query
module.exports = async (
  pageDataQueue: any,
  queryJob: QueryJob,
  component: Any
) => {
  const { schema, program } = store.getState()

  const graphql = (query, context) =>
    graphqlFunction(
      schema,
      query,
      context,
      withResolverContext(context, schema),
      context
    )

  // Run query
  let result
  // Nothing to do if the query doesn't exist.
  if (!queryJob.query || queryJob.query === ``) {
    result = {}
  } else {
    result = await graphql(queryJob.query, queryJob.context)
  }

  // If there's a graphql error then log the error. If we're building, also
  // quit.
  if (result && result.errors) {
    const errorDetails = new Map()
    errorDetails.set(`Errors`, result.errors || [])
    if (queryJob.isPage) {
      errorDetails.set(`URL path`, queryJob.context.path)
      errorDetails.set(
        `Context`,
        JSON.stringify(queryJob.context.context, null, 2)
      )
    }
    errorDetails.set(`Plugin`, queryJob.pluginCreatorId || `none`)
    errorDetails.set(`Query`, queryJob.query)

    report.panicOnBuild(`
The GraphQL query from ${queryJob.componentPath} failed.

${formatErrorDetails(errorDetails)}`)
  }

  // Add the page context onto the results.
  if (queryJob && queryJob.isPage) {
    result[`pageContext`] = Object.assign({}, queryJob.context)
  }

  // Delete internal data from pageContext
  if (result.pageContext) {
    delete result.pageContext.jsonName
    delete result.pageContext.path
    delete result.pageContext.internalComponentName
    delete result.pageContext.component
    delete result.pageContext.componentChunkName
    delete result.pageContext.updatedAt
    delete result.pageContext.pluginCreator___NODE
    delete result.pageContext.pluginCreatorId
    delete result.pageContext.componentPath
    delete result.pageContext.context
  }

  const resultJSON = JSON.stringify(result)
  const resultHash = require(`crypto`)
    .createHash(`sha1`)
    .update(resultJSON)
    .digest(`base64`)

  if (process.env.gatsby_executing_command === `develop`) {
    if (queryJob.isPage) {
      websocketManager.emitPageData({
        result,
        id: queryJob.id,
      })
    } else {
      websocketManager.emitStaticQueryData({
        result,
        id: queryJob.id,
      })
    }
  }

  const existingResult = store.getState().depGraph.queryResults[queryJob.id]

  // If no change, then nothing to do
  if (existingResult && existingResult.hash === resultHash) {
    return result
  }

  debug(`query result changed`, queryJob.id)

  store.dispatch({
    type: `SET_QUERY_RESULT_HASH`,
    payload: {
      id: queryJob.id,
      hash: resultHash,
      isStatic: !queryJob.isPage,
    },
  })

  if (queryJob.isPage) {
    const pageData = {
      path: queryJob.id,
      result,
    }
    invariant(pageDataQueue, `page-data queue hasn't been init'd yet`)
    pageDataQueue.push(pageData)

    // It's a StaticQuery
  } else {
    // Always write file to public/static/d/ folder.
    const resultPath = path.join(
      program.directory,
      `public`,
      `static`,
      `d`,
      `${queryJob.hash}.json`
    )

    // This will eventually go away
    store.dispatch({
      type: `SET_JSON_DATA_PATH`,
      payload: {
        key: queryJob.jsonName,
        value: queryJob.hash,
      },
    })

    await fs.outputFile(resultPath, resultJSON)
  }
  return result
}
