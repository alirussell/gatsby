class Flags {
  constructor() {
    this.nodeTypeCollections = new Set()
    this.schema = false
    this.queryJobs = new Set()
    this.queryResults = new Set()
    this.staticQueryChanged = false
    this.redirectsChanged = false
    this.matchPathsChanged = false
    this.pages = new Set()
    this.pageDatas = new Set()
    this.renderPageDirty = false
  }
  nodeTypeCollection(type) {
    this.nodeTypeCollections.add(type)
  }
  schemaDirty() {
    this.schema = true
  }
  queryJob(pathOrJsonName) {
    if (pathOrJsonName.startsWith(`sq--`)) {
      console.log(`static query changed`)
      this.staticQueryChanged = true
    }
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
  page(path) {
    this.pages.add(path)
  }
  pageData(path) {
    this.pageDatas.add(path)
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
