import React from "react"
import PropTypes from "prop-types"

import InternalPageRenderer from "./page-renderer"
import loader from "./loader"

const ProdPageRenderer = ({ location }) => {
  const pageResources = loader.getPage404(location.pathname)
  return React.createElement(InternalPageRenderer, {
    location,
    pageResources,
    ...pageResources.json,
  })
}

ProdPageRenderer.propTypes = {
  location: PropTypes.shape({
    pathname: PropTypes.string.isRequired,
  }).isRequired,
}

export default ProdPageRenderer
