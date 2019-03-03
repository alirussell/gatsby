const _ = require(`lodash`)

class Flags {
  constructor() {
    this.nodeTypeCollections = {}
    this.schema = false
    this.queryJobs = new Set()
    this.queryResults = new Set()
    this.staticQueryChanged = false
    this.redirectsChanged = false
  }
  nodeTypeCollection(type, id) {
    _.update(this.nodeTypeCollections, type, fooSet =>
      _.defaultTo(fooSet, new Set()).add(id)
    )
  }
  schemaDirty() {
    this.schema = true
  }
  queryJob(pathOrJsonName) {
    this.queryJobs.add(pathOrJsonName)
  }
  queryResult(queryId) {
    this.queryResults.add(queryId)
  }
  staticQuery() {
    this.staticQueryChanged = true
  }
  redirects() {
    this.redirectsChanged = true
  }
}

module.exports = Flags
