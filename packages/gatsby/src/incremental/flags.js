const _ = require(`lodash`)

class Flags {
  constructor() {
    this.nodeTypeCollections = {}
    this.nodes = new Set()
  }
  nodeTypeCollection(type, id) {
    _.update(this.nodeTypeCollections, type, fooSet =>
      _.defaultTo(fooSet, new Set()).add(id)
    )
  }
  node(id) {
    this.nodes.add(id)
  }
}

module.exports = Flags
