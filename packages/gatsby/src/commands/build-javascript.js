/* @flow */
const webpack = require(`webpack`)
const webpackConfig = require(`../utils/webpack.config`)
const { store } = require(`../redux`)

function writeCompilationHash(stats) {
  store.dispatch({
    type: `SET_WEBPACK_JS_COMPILATION_HASH`,
    payload: stats.hash,
  })

  // TODO Write compilation has to a file and have it pulled by site.
}

module.exports = async program => {
  const { directory } = program

  const compilerConfig = await webpackConfig(
    program,
    directory,
    `build-javascript`
  )

  return new Promise((resolve, reject) => {
    webpack(compilerConfig).run((err, stats) => {
      if (err) {
        reject(err)
        return
      }

      const jsonStats = stats.toJson()
      if (jsonStats.errors && jsonStats.errors.length > 0) {
        reject(jsonStats.errors)
        return
      }

      writeCompilationHash(jsonStats)

      resolve()
    })
  })
}
