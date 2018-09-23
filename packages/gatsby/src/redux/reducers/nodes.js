const _ = require(`lodash`)
const db = require(`../../db`)
const invariant = require(`invariant`)

function createNode(node) {
  invariant(node.internal, `node has no "internal" field`)
  invariant(node.internal.type, `node has no "internal.type" field`)
  invariant(node.id, `node has no "id" field`)

  const type = node.internal.type

  let coll = db.db.getCollection(type)
  if (!coll) {
    console.log(`${type} collection doesn't exist. Creating`)
    coll = db.db.addCollection(type, { indices: [`id`] })
  }

  coll.insert(node)
}

function deleteNode(node) {
  invariant(node.internal, `node has no "internal" field`)
  invariant(node.internal.type, `node has no "internal.type" field`)
  invariant(node.id, `node has no "id" field`)

  const type = node.internal.type

  let coll = db.db.getCollection(type)
  if (!coll) {
    invariant(coll, `${type} collection doesn't exist. When trying to delete?`)
  }

  coll.remove(node)
}

function updateNode(node) {
  invariant(node.internal, `node has no "internal" field`)
  invariant(node.internal.type, `node has no "internal.type" field`)
  invariant(node.id, `node has no "id" field`)

  const type = node.internal.type

  let coll = db.db.getCollection(type)
  if (!coll) {
    invariant(coll, `${type} collection doesn't exist. When trying to update?`)
  }

  coll.update(node)
}

module.exports = (state = new Map(), action) => {
  switch (action.type) {
    case `DELETE_CACHE`:
      db.clearAll()
      return new Map()
    case `CREATE_NODE`: {
      console.log(`create_node`)
      createNode(action.payload)
      state.set(action.payload.id, action.payload)
      return state
    }

    case `ADD_FIELD_TO_NODE`:
    case `ADD_CHILD_NODE_TO_PARENT_NODE`:
      updateNode(action.payload)
      state.set(action.payload.id, action.payload)
      return state

    case `DELETE_NODE`: {
      deleteNode(action.payload)
      state.delete(action.payload.id)
      return state
    }

    case `DELETE_NODES`: {
      action.payload.forEach(id => state.delete(id))
      return state
    }

    default:
      return state
  }
}
