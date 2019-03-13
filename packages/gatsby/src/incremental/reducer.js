const _ = require(`lodash`)

const initialState = {
  exampleValues: {},
  inferredTypes: {},
  matchPaths: {},
  pageDependsOnNode: {},
  queryDependsOnNode: {},
  queryDependsOnNodeCollection: {},
  queryResults: {},
  compilationHash: null,
}
// TODO Remember to handle create child, create node field
// A child node will only be created by a transform plugin. And that will only happen if the source plugin has to recreate it. So createNodeField will never occur in a source plugin? No, a site plugin might a field to a parent node in onCreateNode

const uniqPush = val => array => {
  array = _.defaultTo(array, [])
  if (!array.includes(val)) {
    array.push(val)
  }
  return array
}

module.exports = ({ flags }) => {
  function flagDirtyNodes(state, node) {
    //    console.log(`flagging node`, node.internal.type, node.id)
    flags.nodeTypeCollection(node.internal.type)
    const queryId = state.queryDependsOnNode[node.id]
    if (queryId) {
      flags.queryJob(queryId)
    }
  }

  function trackPageDependency(state, node) {
    const {
      internal: { ___gatsbyDependsOnPage: dependsOnPagePath },
    } = node
    if (dependsOnPagePath) {
      //      console.log(`tracking node->page dep`, [dependsOnPagePath, node.id])
      _.set(state, [`pageDependsOnNode`, dependsOnPagePath], node.id)
    }
  }

  return (state = initialState, action) => {
    switch (action.type) {
      case `CREATE_NODE`: {
        flagDirtyNodes(state, action.payload)
        trackPageDependency(state, action.payload)
        break
      }
      case `ADD_FIELD_TO_NODE`:
      case `ADD_CHILD_NODE_TO_PARENT_NODE`:
      case `DELETE_NODE`: {
        flagDirtyNodes(state, action.payload)
        break
      }
      case `SET_EXAMPLE_VALUE`: {
        const { typeName, exampleValue } = action.payload
        _.set(state, [`exampleValues`, typeName], exampleValue)
        break
      }
      case `SET_INFERRED_TYPES`: {
        const printedTypes = action.payload
        state.inferredTypes = printedTypes
        break
      }
      case `SET_INFERRED_TYPE`: {
        const { typeName, printedType } = action.payload
        state.inferredTypes[typeName] = printedType
        break
      }
      case `SET_QUERY_RESULT_HASH`: {
        const { id, isStatic, hash } = action.payload
        _.set(state, [`queryResults`, id], { hash })
        flags.queryResult(id)
        if (isStatic) {
          flags.staticQuery()
        }
        break
      }
      case `SET_WEBPACK_JS_COMPILATION_HASH`: {
        _.set(state, [`compilationHash`], action.payload)
        flags.renderPage()
        break
      }
      case `CREATE_PAGE`: {
        const page = action.payload
        if (page.matchPath) {
          if (action.oldPage && action.oldPage.matchPage !== page.matchPath) {
            delete state.matchPaths[action.oldPage.matchPath]
          }
          state.matchPaths[page.matchPath] = page.path
          flags.matchPaths()
        }
        //        console.log(`page changed. flagging queryJob`, page.path)
        flags.queryJob(page.path)
        break
      }
      case `DELETE_PAGE`: {
        const page = action.payload
        if (page.matchPath) {
          delete state.matchPaths[page.matchPath]
          flags.matchPaths()
        }
        break
      }
      case `CREATE_COMPONENT_DEPENDENCY`: {
        const { nodeId, path, connection } = action.payload
        if (connection) {
          //          console.log(`page->nodeType dep`, connection, path)
          _.update(
            state,
            [`queryDependsOnNodeCollection`, connection],
            uniqPush(path)
          )
        } else {
          //          console.log(`page->node dep`, nodeId, path)
          _.set(state, [`queryDependsOnNode`, nodeId], path)
        }
        break
      }
    }
    return state
  }
}