let created404 = false

exports.sourceNodes = ({ createContentDigest, actions, store }) => {
  // Copy /404/ to /404.html as many static site hosts expect
  // site 404 pages to be named this.
  // https://www.gatsbyjs.org/docs/add-404-page/
  const page404 = store.getState().pages[`/404/`]
  if (page404) {
    actions.createPage({
      ...page404,
      path: `/404.html`,
    })
    created404 = true
  }
}

exports.onCreatePage = ({ page, store, actions }) => {
  // Copy /404/ to /404.html as many static site hosts expect
  // site 404 pages to be named this.
  // https://www.gatsbyjs.org/docs/add-404-page/
  if (!created404 && page.path === `/404/`) {
    actions.createPage({
      ...page,
      path: `/404.html`,
    })
    created404 = true
  }
}
