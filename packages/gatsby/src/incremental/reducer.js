// TODO Remember to handle create child, create node field
// A child node will only be created by a transform plugin. And that will only happen if the source plugin has to recreate it. So createNodeField will never occur in a source plugin? No, a site plugin might a field to a parent node in onCreateNode

module.exports = ({ flags }) => (state = {}, action) => {
  switch (action.type) {
    case `CREATE_NODE`:
    case `ADD_FIELD_TO_NODE`:
    case `ADD_CHILD_NODE_TO_PARENT_NODE`:
    case `DELETE_NODE`: {
      const node = action.payload
      console.log(`flagging node`, node.internal.type, node.id)
      flags.nodeTypeCollection(node.internal.type, node.id)
      flags.node(node.id)
    }
  }
  return state
}
