// const omit = require(`lodash/omit`)

module.exports = (state = {}, action) => {
  switch (action.type) {
    case `SET_JSON_DATA_PATH`:
      state[action.payload.key] = action.payload.value
      return state
    default:
      return state
  }
}
