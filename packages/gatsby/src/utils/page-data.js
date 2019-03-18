const fs = require(`fs-extra`)
const invariant = require(`invariant`)
const path = require(`path`)
const Queue = require(`better-queue`)

// must be initialized via `initQueue`
let queue

function makeHandler({ publicDir, store, flags }) {
  return (pageData, cb) => {
    const pagePath = pageData.path
    const fixedPagePath = pagePath === `/` ? `index` : pagePath
    const page = store.getState().pages.get(pagePath)
    invariant(page, `queryJob path [${pagePath}] not found`)
    const pageDataPath = path.join(
      publicDir,
      `page-data`,
      fixedPagePath,
      `page-data.json`
    )

    // result may be null if a page has no query associated with it
    const result = pageData.result
    const body = {
      componentChunkName: page.componentChunkName,
      path: pagePath,
      ...result,
    }
    fs.outputFile(pageDataPath, JSON.stringify(body))
      .then(() => {
        flags.pageData(pagePath)
        cb(null)
      })
      .catch(cb)
  }
}

function makeQueue({ program, store, flags }) {
  const publicDir = path.join(program.directory, `public`)
  const handler = makeHandler({ publicDir, store, flags })
  return new Queue(handler, {
    id: (task, cb) => {
      cb(null, task.path)
    },
  })
}

function initQueue(args) {
  queue = makeQueue(args)
}

const getQueue = () => queue

module.exports = {
  getQueue,
  initQueue,
}
