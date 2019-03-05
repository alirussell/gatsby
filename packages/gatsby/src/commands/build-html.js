/* @flow */
const webpack = require(`webpack`)

const webpackConfig = require(`../utils/webpack.config`)
const { store, flags } = require(`../redux`)
const { createErrorFromString } = require(`gatsby-cli/lib/reporter/errors`)
const renderHTMLQueue = require(`../utils/html-renderer-queue`)

function buildRenderPage() {
  const program = store.getState().program
  const { directory } = program
  return new Promise((resolve, reject) => {
    webpackConfig(program, directory, `build-html`, null).then(
      compilerConfig => {
        webpack(compilerConfig).run((e, stats) => {
          if (e) {
            reject(e)
          }
          const outputFile = `${directory}/public/render-page.js`
          if (stats.hasErrors()) {
            let webpackErrors = stats.toJson().errors.filter(Boolean)
            return reject(
              webpackErrors.length
                ? createErrorFromString(webpackErrors[0], `${outputFile}.map`)
                : new Error(
                    `There was an issue while building the site: ` +
                      `\n\n${stats.toString()}`
                  )
            )
          }
          resolve()
        })
      }
    )
  })
}

async function buildDirtyPages(activity) {
  const state = store.getState()
  const { program, pages } = state
  const { directory } = program
  const dirtyPages = flags.renderPageDirty
    ? [...pages.keys()]
    : [...flags.pageDatas]

  const outputFile = `${directory}/public/render-page.js`
  try {
    await renderHTMLQueue(outputFile, dirtyPages, activity)
  } catch (e) {
    const prettyError = createErrorFromString(e.stack, `${outputFile}.map`)
    prettyError.context = e.context
    throw prettyError
  }
}

async function buildAll(program, activity) {
  await buildRenderPage()
  await buildDirtyPages(activity)
}

module.exports = {
  buildRenderPage,
  buildDirtyPages,
  buildAll,
}
