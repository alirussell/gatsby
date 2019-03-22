const fs = require(`fs-extra`)
const invariant = require(`invariant`)
const path = require(`path`)
const Queue = require(`better-queue`)
const report = require(`gatsby-cli/lib/reporter`)

// must be initialized via `initQueue`
let queue
let finishedPromise
// disgusting
let firstItemPushed = false

function makeHandler({ publicDir, store, flags }) {
  return (pageData, cb) => {
    try {
      firstItemPushed = true
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
    } catch (err) {
      cb(err)
    }
  }
}

function makeQueue({ program, store, flags }) {
  const publicDir = path.join(program.directory, `public`)
  const handler = makeHandler({ publicDir, store, flags })
  const queue = new Queue(handler, {
    id: (task, cb) => {
      cb(null, task.path)
    },
    maxTimeout: 1000,
    failTaskOnProcessException: true,
  })
  finishedPromise = new Promise((resolve, reject) => {
    queue.on(`drain`, () => {
      resolve()
    })
    queue.on(`task_failed`, (taskId, err, stats) => {
      reject(err)
    })
  })
  return queue
}

function initQueue(args) {
  queue = makeQueue(args)
}

function waitTillDrained() {
  if (!firstItemPushed) {
    return Promise.resolve()
  }
  return finishedPromise
}

const getQueue = () => queue

module.exports = {
  getQueue,
  initQueue,
  waitTillDrained,
}
