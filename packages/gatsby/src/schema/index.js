/* @flow */

const tracer = require(`opentracing`).globalTracer()
const { store, flags } = require(`../redux`)
const nodeStore = require(`../db/nodes`)
const { createSchemaComposer } = require(`./schema-composer`)
const { buildSchema, rebuildSchemaWithSitePage } = require(`./schema`)
const { TypeConflictReporter } = require(`./infer/type-conflict-reporter`)

function makeExampleValueStore() {
  return {
    get: typeName => store.getState().depGraph.exampleValues[typeName],
    save: (typeName, exampleValue) => {
      store.dispatch({
        type: `SET_EXAMPLE_VALUE`,
        payload: {
          typeName,
          exampleValue,
        },
      })
    },
    saveInferredTypes: printedInferredTypes => {
      console.log(`saving inferred types`)
      store.dispatch({
        type: `SET_INFERRED_TYPES`,
        payload: printedInferredTypes,
      })
      flags.schemaDirty()
    },
    getInferredTypes: () => store.getState().depGraph.inferredTypes,
  }
}

module.exports.build = async ({ parentSpan }) => {
  const spanArgs = parentSpan ? { childOf: parentSpan } : {}
  const span = tracer.startSpan(`build schema`, spanArgs)

  let {
    schemaCustomization: { thirdPartySchemas, types },
    config: { mapping: typeMapping },
  } = store.getState()

  const typeConflictReporter = new TypeConflictReporter()

  const dirtyNodeCollections = flags.nodeTypeCollections

  const schemaComposer = createSchemaComposer()
  const schema = await buildSchema({
    schemaComposer,
    nodeStore,
    types,
    thirdPartySchemas,
    typeMapping,
    exampleValueStore: makeExampleValueStore(),
    dirtyNodeCollections,
    typeConflictReporter,
    parentSpan,
  })

  typeConflictReporter.printConflicts()

  store.dispatch({
    type: `SET_SCHEMA_COMPOSER`,
    payload: schemaComposer,
  })
  store.dispatch({
    type: `SET_SCHEMA`,
    payload: schema,
  })

  span.finish()
}

module.exports.rebuildWithSitePage = async ({ parentSpan }) => {
  console.log(`with site page`)
  const spanArgs = parentSpan ? { childOf: parentSpan } : {}
  const span = tracer.startSpan(
    `rebuild schema with SitePage context`,
    spanArgs
  )
  let {
    schemaCustomization: { composer: schemaComposer },
    config: { mapping: typeMapping },
  } = store.getState()

  const typeConflictReporter = new TypeConflictReporter()

  const dirtyNodeCollections = flags.nodeTypeCollections

  const schema = await rebuildSchemaWithSitePage({
    schemaComposer,
    nodeStore,
    typeMapping,
    exampleValueStore: makeExampleValueStore(),
    dirtyNodeCollections,
    typeConflictReporter,
    parentSpan,
  })

  typeConflictReporter.printConflicts()

  store.dispatch({
    type: `SET_SCHEMA_COMPOSER`,
    payload: schemaComposer,
  })
  store.dispatch({
    type: `SET_SCHEMA`,
    payload: schema,
  })

  span.finish()
}
