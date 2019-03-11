const _ = require(`lodash`)
const report = require(`gatsby-cli/lib/reporter`)
const { getExampleValue } = require(`./example-value`)
const {
  addNodeInterface,
  getNodeInterface,
} = require(`../types/node-interface`)
const { addInferredFields } = require(`./add-inferred-fields`)
const getInferConfig = require(`./get-infer-config`)
const { printType } = require(`graphql`)

function eqSet(as, bs) {
  if (as.size !== bs.size) return false
  for (var a of as) if (!bs.has(a)) return false
  return true
}

const addInferredType = ({
  schemaComposer,
  typeComposer,
  nodeStore,
  typeConflictReporter,
  dirtyNodeCollections,
  exampleValueStore,
  typeMapping,
  parentSpan,
}) => {
  const typeName = typeComposer.getTypeName()

  let exampleValue
  const oldExampleValue = exampleValueStore.get(typeName)
  if (!oldExampleValue || dirtyNodeCollections.has(typeName)) {
    console.log(`${typeName} collection dirty. Creating example value`)
    exampleValue = getExampleValue({
      nodes: nodeStore.getNodesByType(typeName),
      typeName,
      typeConflictReporter,
      ignoreFields: [
        ...getNodeInterface({ schemaComposer }).getFieldNames(),
        `$loki`,
      ],
    })
    const oldValue = exampleValueStore.get(typeName)
    if (!_.isEqual(exampleValue, oldValue)) {
      if (typeName === `SitePage`) {
        console.log(`${typeName} exampleValue has changed`)
      }
      exampleValueStore.save(typeName, exampleValue)
    }
  } else {
    exampleValue = oldExampleValue
  }

  addInferredFields({
    schemaComposer,
    typeComposer,
    nodeStore,
    exampleValue,
    inferConfig: getInferConfig(typeComposer),
    typeMapping,
    parentSpan,
  })
  return typeComposer
}

const addInferredTypes = ({
  schemaComposer,
  nodeStore,
  typeConflictReporter,
  exampleValueStore,
  dirtyNodeCollections,
  typeMapping,
  parentSpan,
}) => {
  // XXX(freiksenet): Won't be needed after plugins set typedefs
  // Infer File first so all the links to it would work
  const typeNames = putFileFirst(nodeStore.getTypes())
  const noNodeInterfaceTypes = []

  typeNames.forEach(typeName => {
    let typeComposer
    let inferConfig
    if (schemaComposer.has(typeName)) {
      typeComposer = schemaComposer.getTC(typeName)
      inferConfig = getInferConfig(typeComposer)
      if (inferConfig.infer) {
        if (!typeComposer.hasInterface(`Node`)) {
          noNodeInterfaceTypes.push(typeComposer.getType())
        }
      }
    } else {
      typeComposer = schemaComposer.createTC(typeName)
      addNodeInterface({ schemaComposer, typeComposer })
    }
  })

  // XXX(freiksenet): We iterate twice to pre-create all types
  const typeComposers = typeNames.map(typeName => {
    addInferredType({
      schemaComposer,
      nodeStore,
      typeConflictReporter,
      typeComposer: schemaComposer.getTC(typeName),
      exampleValueStore,
      dirtyNodeCollections,
      typeMapping,
      parentSpan,
    })
  })

  if (noNodeInterfaceTypes.length > 0) {
    noNodeInterfaceTypes.forEach(type => {
      report.warn(
        `Type \`${type}\` declared in \`createTypes\` looks like a node, ` +
          `but doesn't implement a \`Node\` interface. It's likely that you should ` +
          `add the \`Node\` interface to your type def:\n\n` +
          `\`type ${type} implements Node { ... }\`\n\n` +
          `If you know that you don't want it to be a node (which would mean no ` +
          `root queries to retrieve it), you can explicitly disable inference ` +
          `for it:\n\n` +
          `\`type ${type} @dontInfer { ... }\``
      )
    })
    report.panic(`Building schema failed`)
  }

  const storedTypes = exampleValueStore.getInferredTypes()
  if (!eqSet(new Set(Object.keys(storedTypes)), new Set(typeNames))) {
    // If the typeNames are in any way different, then resave the
    // types from scratch to be safe
    const printedTypes = typeNames.map(typeName =>
      printType(schemaComposer.getTC(typeName).getType())
    )
    exampleValueStore.saveInferredTypes(typeNames, printedTypes)
  } else {
    // Otherwise, just resave the typeNames that have changed
    typeNames.forEach(typeName =>
      exampleValueStore.saveTypeIfChanged(schemaComposer, typeName)
    )
  }

  return typeComposers
}

const putFileFirst = typeNames => {
  const index = typeNames.indexOf(`File`)
  if (index !== -1) {
    return [`File`, ...typeNames.slice(0, index), ...typeNames.slice(index + 1)]
  } else {
    return typeNames
  }
}

module.exports = {
  addInferredType,
  addInferredTypes,
}
