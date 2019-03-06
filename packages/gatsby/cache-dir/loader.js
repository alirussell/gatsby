import emitter from "./emitter"
import prefetchHelper from "./prefetch"
import { match } from "@reach/router/lib/utils"
import stripPrefix from "./strip-prefix"
import matchPaths from "./match-paths.json"

const preferDefault = m => (m && m.default) || m

let devGetPageData
let inInitialRender = true
let hasFetched = Object.create(null)
let syncRequires = {}
let asyncRequires = {}
let jsonDataPaths = {}
let fetchHistory = []
// /**
//  * Indicate if pages manifest is loaded
//  *  - in production it is split to separate "pages-manifest" chunk that need to be lazy loaded,
//  *  - in development it is part of single "common" chunk and is available from the start.
//  */
// let hasPageGlobals = process.env.NODE_ENV !== `production`
let apiRunner
const failedPaths = {}
const MAX_HISTORY = 5

const fetchedPageData = {}
const pageDatas = {}
const jsonPromiseStore = {}

if (process.env.NODE_ENV !== `production`) {
  devGetPageData = require(`./socketIo`).getPageData
}

const pathCache = {}

const findPath = rawPathname => {
  let pathname = decodeURIComponent(rawPathname)
  // Remove the pathPrefix from the pathname.
  let trimmedPathname = stripPrefix(pathname, __PATH_PREFIX__)
  // Remove any hashfragment
  if (trimmedPathname.split(`#`).length > 1) {
    trimmedPathname = trimmedPathname
      .split(`#`)
      .slice(0, -1)
      .join(``)
  }

  // Remove search query
  if (trimmedPathname.split(`?`).length > 1) {
    trimmedPathname = trimmedPathname
      .split(`?`)
      .slice(0, -1)
      .join(``)
  }
  if (pathCache[trimmedPathname]) {
    return pathCache[trimmedPathname]
  }

  let foundPath
  console.log(matchPaths)
  Object.keys(matchPaths).some(matchPath => {
    const path = matchPaths[matchPath]
    console.log(matchPath, path)
    console.log(match)
    if (match(matchPath, trimmedPathname)) {
      foundPath = path
      pathCache[trimmedPathname] = foundPath
      return foundPath
    }
    // Finally, try and match request with default document.
    if (trimmedPathname === `/index.html`) {
      foundPath = `/`
      pathCache[trimmedPathname] = foundPath
      return foundPath
    }
    return false
  })
  pathCache[trimmedPathname] = trimmedPathname
  return trimmedPathname
}

// const createJsonURL = jsonName => `${__PATH_PREFIX__}/static/d/${jsonName}.json`
const createComponentUrls = componentChunkName =>
  window.___chunkMapping[componentChunkName].map(
    chunk => __PATH_PREFIX__ + chunk
  )

const runFetchResource = (resourceName, resourceFunction) => {
  // Download the resource
  hasFetched[resourceName] = true
  return new Promise(resolve => {
    const fetchPromise = resourceFunction()
    let failed = false
    return fetchPromise
      .catch(() => {
        failed = true
      })
      .then(resource => {
        fetchHistory.push({
          resource: resourceName,
          succeeded: !failed,
        })

        fetchHistory = fetchHistory.slice(-MAX_HISTORY)

        resolve(resource)
      })
  })
}

const fetchResource = (resourceName, url = jsonDataPaths[resourceName]) => {
  // Find resource
  let resourceFunction
  if (resourceName in jsonPromiseStore) {
    resourceFunction = () => jsonPromiseStore[resourceName]
  } else {
    resourceFunction = () => {
      const fetchPromise = new Promise((resolve, reject) => {
        const req = new XMLHttpRequest()
        req.open(`GET`, url, true)
        req.withCredentials = true
        req.onreadystatechange = () => {
          if (req.readyState == 4) {
            if (req.status === 200) {
              resolve(JSON.parse(req.responseText))
            } else {
              delete jsonPromiseStore[resourceName]
              reject()
            }
          }
        }
        req.send(null)
      })
      jsonPromiseStore[resourceName] = fetchPromise
      return fetchPromise
    }
  }

  return runFetchResource(resourceName, resourceFunction)
}

const stripSurroundingSlashes = s => {
  s = s[0] === `/` ? s.slice(1) : s
  s = s.endsWith(`/`) ? s.slice(0, -1) : s
  return s
}

const makePageDataUrl = path => {
  const fixedPath = path === `/` ? `index` : stripSurroundingSlashes(path)
  return `${__PATH_PREFIX__}/page-data/${fixedPath}/page-data.json`
}

const fetchPageData = path => {
  const url = makePageDataUrl(path)
  return fetchResource(path, url).then((pageData, err) => {
    fetchedPageData[path] = true
    if (pageData) {
      pageDatas[path] = pageData
      return pageData
    } else {
      failedPaths[path] = err
      return null
    }
  })
}

const prefetchPageData = path => prefetchHelper(makePageDataUrl(path))

const prefetchComponent = chunkName =>
  Promise.all(createComponentUrls(chunkName).map(prefetchHelper))

const appearsOnLine = () => {
  const isOnLine = navigator.onLine
  if (typeof isOnLine === `boolean`) {
    return isOnLine
  }

  // If no navigator.onLine support assume onLine if any of last N fetches succeeded
  const succeededFetch = fetchHistory.find(entry => entry.succeeded)
  return !!succeededFetch
}

const handleResourceLoadError = (path, message) => {
  if (!failedPaths[path]) {
    failedPaths[path] = message
  }

  if (
    appearsOnLine() &&
    window.location.pathname.replace(/\/$/g, ``) !== path.replace(/\/$/g, ``)
  ) {
    window.location.pathname = path
  }
}

const onPrefetchPathname = pathname => {
  if (!prefetchTriggered[pathname]) {
    apiRunner(`onPrefetchPathname`, { pathname })
    prefetchTriggered[pathname] = true
  }
}

const onPostPrefetchPathname = pathname => {
  if (!prefetchCompleted[pathname]) {
    apiRunner(`onPostPrefetchPathname`, { pathname })
    prefetchCompleted[pathname] = true
  }
}

/**
 * Check if we should fallback to resources for 404 page if resources for a page are not found
 *
 * We can't do that when we don't have full pages manifest - we don't know if page exist or not if we don't have it.
 * We also can't do that on initial render / mount in case we just can't load resources needed for first page.
 * Not falling back to 404 resources will cause "EnsureResources" component to handle scenarios like this with
 * potential reload
 * @param {string} path Path to a page
 */
const shouldFallbackTo404Resources = path =>
  inInitialRender && path !== `/404.html`

// Note we're not actively using the path data atm. There
// could be future optimizations however around trying to ensure
// we load all resources for likely-to-be-visited paths.
// let pathArray = []
// let pathCount = {}

let pathScriptsCache = {}
let prefetchTriggered = {}
let prefetchCompleted = {}
let disableCorePrefetching = false

const queue = {
  addPageData: pageData => {
    pageDatas[pageData.path] = pageData
  },
  addDevRequires: devRequires => {
    syncRequires = devRequires
  },
  addProdRequires: prodRequires => {
    asyncRequires = prodRequires
  },
  // Hovering on a link is a very strong indication the user is going to
  // click on it soon so let's start prefetching resources for this
  // pathname.
  hovering: path => {
    console.log(`hovering`)
    queue.getResourcesForPathname(path)
  },
  enqueue: rawPath => {
    console.log(`enqueueing`)
    if (!apiRunner)
      console.error(`Run setApiRunnerForLoader() before enqueing paths`)

    // Skip prefetching if we know user is on slow or constrained connection
    if (`connection` in navigator) {
      if ((navigator.connection.effectiveType || ``).includes(`2g`)) {
        return false
      }
      if (navigator.connection.saveData) {
        return false
      }
    }

    // Tell plugins with custom prefetching logic that they should start
    // prefetching this path.
    onPrefetchPathname(rawPath)

    // If a plugin has disabled core prefetching, stop now.
    if (disableCorePrefetching.some(a => a)) {
      return false
    }

    // Check if the page exists.
    let realPath = findPath(rawPath)

    if (pageDatas[realPath]) {
      return true
    }

    // TODO
    // if (
    //   process.env.NODE_ENV !== `production` &&
    //   process.env.NODE_ENV !== `test`
    // ) {
    //   devGetPageData(page.path)
    // }

    // Prefetch resources.
    if (process.env.NODE_ENV === `production`) {
      prefetchPageData(realPath).then(() => {
        // Tell plugins the path has been successfully prefetched
        onPostPrefetchPathname(realPath)
      })
    }

    return true
  },

  // TODO
  // getPage: pathname => findPage(pathname),

  // TODO doesn't make sense. No such thing as a jsonURL anymore
  // getResourceURLsForPathname: path => {
  //   const page = findPage(path)
  //   if (page) {
  //     return [
  //       ...createComponentUrls(page.componentChunkName),
  //       createJsonURL(jsonDataPaths[page.jsonName]),
  //     ]
  //   } else {
  //     return null
  //   }
  // },

  getResourcesForPathnameSync: rawPath => {
    const realPath = findPath(rawPath)
    if (realPath) {
      return pathScriptsCache[realPath]
    } else if (shouldFallbackTo404Resources(realPath)) {
      return queue.getResourcesForPathnameSync(`/404.html`)
    } else {
      return null
    }
  },

  getResourcesForPathname: rawPath =>
    new Promise((resolve, reject) => {
      // Production code path
      if (failedPaths[rawPath]) {
        handleResourceLoadError(
          rawPath,
          `Previously detected load failure for "${rawPath}"`
        )
        reject()
        return
      }

      console.log(`before find path`)
      const realPath = findPath(rawPath)

      if (!fetchedPageData[realPath]) {
        fetchPageData(realPath).then(() =>
          resolve(queue.getResourcesForPathname(rawPath))
        )
        return
      }

      const pageData = pageDatas[realPath]

      if (!pageData) {
        if (shouldFallbackTo404Resources(realPath)) {
          console.log(`A page wasn't found for "${rawPath}"`)

          // Preload the custom 404 page
          resolve(queue.getResourcesForPathname(`/404.html`))
          return
        }

        resolve()
        return
      }

      // Check if it's in the cache already.
      if (pathScriptsCache[realPath]) {
        const pageResources = pathScriptsCache[realPath]
        emitter.emit(`onPostLoadPageResources`, {
          page: pageResources,
          pageResources: pathScriptsCache[realPath],
        })
        resolve(pageResources)
        return
      }

      // Nope, we need to load resource(s)
      emitter.emit(`onPreLoadPageResources`, {
        path: realPath,
      })

      const { componentChunkName } = pageData

      if (process.env.NODE_ENV !== `production`) {
        const page = {
          componentChunkName: pageData.componentChunkName,
          path: pageData.path,
        }
        const pageResources = {
          component: syncRequires.components[page.componentChunkName],
          page,
        }

        // Add to the cache.
        pathScriptsCache[realPath] = pageResources
        devGetPageData(page.path).then(pageData => {
          emitter.emit(`onPostLoadPageResources`, {
            page,
            pageResources,
          })
          // Tell plugins the path has been successfully prefetched
          onPostPrefetchPathname(realPath)

          resolve(pageResources)
        })
      } else {
        console.log(`getting component`)
        const fetchFn = asyncRequires.components[componentChunkName]
        runFetchResource(componentChunkName, fetchFn)
          .then(preferDefault)
          .then(component => {
            console.log(`got component`)
            if (!component) {
              resolve(null)
              return
            }

            const page = {
              componentChunkName,
              path: pageData.path,
            }

            const jsonData = {
              data: pageData.data,
              pageContext: pageData.pageContext,
            }

            console.log(jsonData)
            const pageResources = {
              component,
              json: jsonData,
              page,
            }
            console.log(pageResources)

            // TODO
            // pageResources.page.jsonURL = createJsonURL(
            //   jsonDataPaths[page.jsonName]
            // )
            pathScriptsCache[realPath] = pageResources
            resolve(pageResources)

            emitter.emit(`onPostLoadPageResources`, {
              page,
              pageResources,
            })

            // Tell plugins the path has been successfully prefetched
            onPostPrefetchPathname(realPath)
          })
      }
    }),
}

export const setApiRunnerForLoader = runner => {
  apiRunner = runner
  disableCorePrefetching = apiRunner(`disableCorePrefetching`)
}

export const publicLoader = {
  getResourcesForPathname: queue.getResourcesForPathname,
  // getResourceURLsForPathname: queue.getResourceURLsForPathname,
  getResourcesForPathnameSync: queue.getResourcesForPathnameSync,
}

export default queue
