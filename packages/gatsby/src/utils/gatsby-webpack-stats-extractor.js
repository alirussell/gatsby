const fs = require(`fs-extra`)
const path = require(`path`)
const { store } = require(`../redux`)

class GatsbyWebpackStatsExtractor {
  constructor(options) {
    this.plugin = { name: `GatsbyWebpackStatsExtractor` }
    this.options = options || {}
  }
  apply(compiler) {
    compiler.hooks.done.tapAsync(this.plugin, (stats, done) => {
      let assets = {}
      let assetsMap = {}
      for (let chunkGroup of stats.compilation.chunkGroups) {
        if (chunkGroup.name) {
          let files = []
          for (let chunk of chunkGroup.chunks) {
            files.push(...chunk.files)
          }
          assets[chunkGroup.name] = files.filter(f => f.slice(-4) !== `.map`)
          assetsMap[chunkGroup.name] = files
            .filter(
              f =>
                f.slice(-4) !== `.map` &&
                f.slice(0, chunkGroup.name.length) === chunkGroup.name
            )
            .map(filename => `/${filename}`)
        }
      }
      const statsJson = stats.toJson({ all: false, chunkGroups: true, hash: true })
      const result = store.dispatch({
        type: `SET_WEBPACK_JS_COMPILATION_HASH`,
        payload: statsJson.hash,
      })
      const webpackStats = {
        ...statsJson,
        assetsByChunkName: assets,
      }
      fs.writeFile(
        path.join(`public`, `chunk-map.json`),
        JSON.stringify(assetsMap),
        () => {
          fs.writeFile(
            path.join(`public`, `webpack.stats.json`),
            JSON.stringify(webpackStats),
            done
          )
        }
      )
    })
  }
}

module.exports = GatsbyWebpackStatsExtractor
