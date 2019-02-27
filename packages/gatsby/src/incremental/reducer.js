const initialState = {
  nodeTypeCollections: new Set(),
  queryResults: new Set(),
}

module.exports = (state = initialState, action) => {
  switch (action.type) {
    case `CREATE_NODE`:
      const node = action.payload
      state.nodeTypeCollections.add(node.internal.type)
      return state

    case `TOUCH_NODE`:
      state[action.payload] = true
      return state

    default:
      return state
  }
}
