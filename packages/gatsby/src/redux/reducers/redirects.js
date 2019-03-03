const _ = require(`lodash`)

module.exports = ({ flags }) => (state = [], action) => {
  switch (action.type) {
    case `CREATE_REDIRECT`: {
      const redirect = action.payload
      if (!state.some(r => _.isEqual(r, redirect))) {
        // Add redirect only if it wasn't yet added to prevent duplicates
        flags.redirects()
        return [...state, redirect]
      }
      return state
    }

    default:
      return state
  }
}
