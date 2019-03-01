const _ = require(`lodash`)

const initialState = {
  exampleValues: {},
  matchPaths: {},
  pageDependsOnNode: {},
}
// TODO Remember to handle create child, create node field
// A child node will only be created by a transform plugin. And that will only happen if the source plugin has to recreate it. So createNodeField will never occur in a source plugin? No, a site plugin might a field to a parent node in onCreateNode

module.exports = ({ flags }) => {
  function flagDirtyNodes(node) {
    console.log(`flagging node`, node.internal.type, node.id)
    flags.nodeTypeCollection(node.internal.type, node.id)
    flags.node(node.id)
  }

  function trackPageDependency(state, node) {
    const {
      internal: { ___gatsbyDependsOnPage: dependsOnPagePath },
    } = node
    if (dependsOnPagePath) {
      console.log(`tracking node->page dep`, [dependsOnPagePath, node.id])
      _.set(state, [`pageDependsOnNode`, dependsOnPagePath], node.id)
    }
  }

  return (state = initialState, action) => {
    switch (action.type) {
      case `CREATE_NODE`: {
        flagDirtyNodes(action.payload)
        trackPageDependency(state, action.payload)
        break
      }
      case `ADD_FIELD_TO_NODE`:
      case `ADD_CHILD_NODE_TO_PARENT_NODE`:
      case `DELETE_NODE`: {
        flagDirtyNodes(action.payload)
        break
      }
      case `SET_DEP_EXAMPLE_VALUE_HASH`: {
        const { type, hash } = action.payload
        _.set(state, [`exampleValues`, type], hash)
        break
      }
      case `CREATE_PAGE`: {
        const page = action.payload
        if (page.matchPath) {
          state.matchPaths[page.matchPath] = page.path
        }
        console.log(`page changed. flagging queryJob`, page.path)
        flags.queryJob(page.path)
        break
      }
      case `DELETE_PAGE`: {
        const page = action.payload
        if (page.matchPath) {
          delete state.matchPaths[page.matchPath]
        }
        break
      }
    }
    return state
  }
}
