module.exports = (state = new Set(), action) => {
  switch (action.type) {
    case `DELETE_CACHE`:
      return new Set()
    case `CREATE_PAGE`:
      return state.add(action.payload.path)

    case `TOUCH_PAGE`:
      return state.add(action.payload.path)

    default:
      return state
  }
}
