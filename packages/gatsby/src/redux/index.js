const Redux = require(`redux`)
const _ = require(`lodash`)
const fs = require(`fs`)
const mitt = require(`mitt`)
const stringify = require(`json-stringify-safe`)
const Flags = require(`../incremental/flags`)

const flags = new Flags()

// Create event emitter for actions
const emitter = mitt()

// Reducers
const reducers = require(`./reducers`)({ flags })

const objectToMap = obj => {
  let map = new Map()
  Object.keys(obj).forEach(key => {
    map.set(key, obj[key])
  })
  return map
}

const mapToObject = map => {
  const obj = {}
  for (let [key, value] of map) {
    obj[key] = value
  }
  return obj
}

// Read from cache the old node data.
let initialState = {}
try {
  const file = fs.readFileSync(`${process.cwd()}/.cache/redux-state.json`)
  // Apparently the file mocking in node-tracking-test.js
  // can override the file reading replacing the mocked string with
  // an already parsed object.
  if (Buffer.isBuffer(file) || typeof file === `string`) {
    initialState = JSON.parse(file)
  }
  if (initialState.staticQueryComponents) {
    initialState.staticQueryComponents = objectToMap(
      initialState.staticQueryComponents
    )
  }
  if (initialState.components) {
    initialState.components = objectToMap(initialState.components)
  }
  if (initialState.pages) {
    initialState.pages = objectToMap(initialState.pages)
  }
  if (initialState.nodes) {
    initialState.nodes = objectToMap(initialState.nodes)

    initialState.nodesByType = new Map()
    initialState.nodes.forEach(node => {
      const { type } = node.internal
      if (!initialState.nodesByType.has(type)) {
        initialState.nodesByType.set(type, new Map())
      }
      initialState.nodesByType.get(type).set(node.id, node)
    })
  }
} catch (e) {
  // ignore errors.
}

const store = Redux.createStore(
  Redux.combineReducers({ ...reducers }),
  initialState,
  Redux.applyMiddleware(function multi({ dispatch }) {
    return next => action =>
      Array.isArray(action)
        ? action.filter(Boolean).map(dispatch)
        : next(action)
  })
)

// Persist state.
function saveState() {
  const state = store.getState()
  const pickedState = _.pick(state, [
    `program`,
    `config`,
    `nodes`,
    `status`,
    `depGraph`,
    `pages`,
    `componentDataDependencies`,
    `jsonDataPaths`,
    `components`,
    `staticQueryComponents`,
    `redirects`,
  ])

  pickedState.staticQueryComponents = mapToObject(
    pickedState.staticQueryComponents
  )
  pickedState.components = mapToObject(pickedState.components)
  pickedState.nodes = pickedState.nodes ? mapToObject(pickedState.nodes) : []
  pickedState.pages = pickedState.pages ? mapToObject(pickedState.pages) : []
  const stringified = stringify(pickedState, null, 2)
  fs.writeFile(
    `${process.cwd()}/.cache/redux-state.json`,
    stringified,
    () => {}
  )
}

exports.saveState = saveState

store.subscribe(() => {
  const lastAction = store.getState().lastAction
  emitter.emit(lastAction.type, lastAction)
})

/** Event emitter */
exports.emitter = emitter

/** Redux store */
exports.store = store

exports.flags = flags
