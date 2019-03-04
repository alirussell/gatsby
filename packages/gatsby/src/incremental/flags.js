const _ = require(`lodash`)

class Flags {
  constructor() {
    this.nodeTypeCollections = {}
    this.schema = false
    this.queryJobs = new Set()
    this.queryResults = new Set()
    this.staticQueryChanged = false
    this.redirectsChanged = false
    this.matchPathsChanged = false
    this.pageManifests = new Set()
    this.renderPageDirty = false
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
  matchPaths() {
    this.matchPathsChanged = true
  }
  pageManifest(path) {
    this.pageManifests.add(path)
  }
  renderPage() {
    this.renderPageDirty = true
  }
  isWebpackDirty() {
    return (
      this.matchPathsChanged || this.staticQueryChanged || this.redirectsChanged
    )
  }
}

module.exports = Flags
