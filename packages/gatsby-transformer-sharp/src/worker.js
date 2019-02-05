const imageSize = require(`probe-image-size`)
const sharp = require(`gatsby-plugin-sharp`)
const fs = require(`fs`)
const fsExtra = require(`fs-extra`)
const path = require(`path`)

async function getTracedSVG(context, { file, image, fieldArgs }) {
  return await sharp.traceSVG({
    file,
    args: { ...fieldArgs.traceSVG },
    fileArgs: fieldArgs,
  })
}

async function fixed(context, args) {
  return await sharp.fixed({
    reporter: context.reporter,
    cache: context.cache,
    ...args,
  })
}

function toArray(buf) {
  var arr = new Array(buf.length)

  for (var i = 0; i < buf.length; i++) {
    arr[i] = buf[i]
  }

  return arr
}

function fluid(context, args) {
  return sharp.fluid({
    reporter: context.reporter,
    cache: context.cache,
    ...args,
  })
}

function original(context, image, details) {
  const { pathPrefix } = context
  const dimensions = imageSize.sync(
    toArray(fs.readFileSync(details.absolutePath))
  )
  const imageName = `${details.name}-${image.internal.contentDigest}${
    details.ext
  }`
  const publicPath = path.join(process.cwd(), `public`, `static`, imageName)

  if (!fsExtra.existsSync(publicPath)) {
    fsExtra.copy(details.absolutePath, publicPath, err => {
      if (err) {
        console.error(
          `error copying file from ${details.absolutePath} to ${publicPath}`,
          err
        )
      }
    })
  }

  return {
    width: dimensions.width,
    height: dimensions.height,
    src: `${pathPrefix}/static/${imageName}`,
  }
}

module.exports = {
  getTracedSVG,
  fixed,
  fluid,
  original,
}
