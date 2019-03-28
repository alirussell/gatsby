import emitter from "./emitter"
import prefetchHelper from "./prefetch"
import { match } from "@reach/router/lib/utils"
import stripPrefix from "./strip-prefix"
import matchPaths from "./match-paths.json"

const preferDefault = m => (m && m.default) || m

let devGetPageData
let syncRequires = {}
let asyncRequires = {}
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
const fetchPromiseStore = {}

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
  Object.keys(matchPaths).some(matchPath => {
    if (match(matchPath, trimmedPathname)) {
      foundPath = matchPaths[matchPath]
      return foundPath
    }
    // Finally, try and match request with default document.
    if (trimmedPathname === `/index.html`) {
      foundPath = `/`
      return foundPath
    }
    return false
  })
  if (!foundPath) {
    foundPath = trimmedPathname
  }
  pathCache[trimmedPathname] = foundPath
  return foundPath
}

const wrapHistory = fetchPromise => {
  let succeeded = false
  return fetchPromise
    .then(resource => {
      succeeded = true
      return resource
    })
    .finally(() => {
      fetchHistory.push({ succeeded })
      fetchHistory = fetchHistory.slice(-MAX_HISTORY)
    })
}

const cachedFetch = (resourceName, fetchFn) => {
  if (resourceName in fetchPromiseStore) {
    return fetchPromiseStore[resourceName]
  } else {
    const promise = wrapHistory(fetchFn(resourceName))
    fetchPromiseStore[resourceName] = promise
    return promise.catch(err => {
      delete fetchPromiseStore[resourceName]
      return err
    })
  }
}

const fetchUrl = url =>
  new Promise((resolve, reject) => {
    const req = new XMLHttpRequest()
    req.open(`GET`, url, true)
    req.withCredentials = true
    req.onreadystatechange = () => {
      if (req.readyState == 4) {
        if (req.status === 200) {
          // TODO is this safe? Maybe just do this check in dev mode?
          const contentType = req.getResponseHeader(`content-type`)
          if (!contentType || !contentType.startsWith(`application/json`)) {
            reject()
          } else {
            resolve(JSON.parse(req.responseText))
          }
        } else {
          reject()
        }
      }
    }
    req.send(null)
  })

const createComponentUrls = componentChunkName =>
  window.___chunkMapping[componentChunkName].map(
    chunk => __PATH_PREFIX__ + chunk
  )

const fetchComponent = chunkName => asyncRequires.components[chunkName]()

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
  console.log(`url`, url)
  return cachedFetch(url, fetchUrl).then((pageData, err) => {
    fetchedPageData[path] = true
    if (pageData) {
      pageDatas[path] = pageData
      return pageData
    } else {
      console.log(`setting failed path`)
      failedPaths[path] = err || `failed path`
      return null
    }
  })
}

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

const onPostPrefetch = url => {
  if (!prefetchCompleted[url]) {
    apiRunner(`onPostPrefetch`, { url })
    prefetchCompleted[url] = true
  }
}

// TODO review to make sure this makes sense
const shouldFallbackTo404Resources = path => path !== `/404.html`

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
    queue.loadPage(path).catch(err => {
      console.log(`hovering page not found`, path)
    })
  },
  enqueue: rawPath => {
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

    if (
      process.env.NODE_ENV !== `production` &&
      process.env.NODE_ENV !== `test`
    ) {
      // Ensure latest version of page data is in the JSON store
      devGetPageData(realPath)
    }

    if (process.env.NODE_ENV === `production`) {
      const pageDataUrl = makePageDataUrl(realPath)
      prefetchHelper(pageDataUrl)
        .then(() =>
          // This was just prefetched, so will return a response from
          // the cache instead of making another request to the server
          fetchUrl(pageDataUrl)
        )
        .then(pageData => {
          // Tell plugins the path has been successfully prefetched
          const chunkName = pageData.componentChunkName
          const componentUrls = createComponentUrls(chunkName)
          return Promise.all(componentUrls.map(prefetchHelper)).then(() => {
            const resourceUrls = [pageDataUrl].concat(componentUrls)
            onPostPrefetch({
              path: rawPath,
              resourceUrls,
            })
          })
        })
    }

    return true
  },

  // getResourcesForPathnameSync: rawPath => {
  //   const realPath = findPath(rawPath)
  //   console.log(
  //     `getResourcesForPathnameSync: rawPath: [${rawPath}], realPath: [${realPath}]`
  //   )
  //   if (realPath in pathScriptsCache) {
  //     return pathScriptsCache[realPath]
  //   } else if (shouldFallbackTo404Resources(realPath)) {
  //     return queue.getResourcesForPathnameSync(`/404.html`)
  //   } else {
  //     return null
  //   }
  // },

  isFailedPath: pathname => !!failedPaths[pathname],

  loadPageData: rawPath =>
    new Promise((resolve, reject) => {
      const realPath = findPath(rawPath)
      console.log(`load page data`, rawPath, realPath)
      if (!fetchedPageData[realPath]) {
        fetchPageData(realPath).then(pageData => {
          if (process.env.NODE_ENV !== `production`) {
            devGetPageData(realPath)
          }
          resolve(queue.loadPageData(rawPath))
        })
      } else {
        if (pageDatas[realPath]) {
          resolve(pageDatas[realPath])
        } else {
          reject(new Error(`page not found`))
        }
      }
    }),

  loadPage: rawPath =>
    queue
      .loadPageData(rawPath)
      .then(pageData => {
        console.log(`loadPage. pageData`, pageData)
        if (process.env.NODE_ENV !== `production`) {
          const component = syncRequires.components[pageData.componentChunkName]
          return [pageData, component]
        } else {
          return cachedFetch(pageData.componentChunkName, fetchComponent)
            .then(preferDefault)
            .then(component => [pageData, component])
        }
      })
      .then(([pageData, component]) => {
        console.log(`loadPage. component`, pageData, component)
        const page = {
          componentChunkName: pageData.componentChunkName,
          path: pageData.path,
          compilationHash: pageData.compilationHash,
        }

        const jsonData = {
          data: pageData.data,
          pageContext: pageData.pageContext,
        }

        const pageResources = {
          component,
          json: jsonData,
          page,
        }

        pathScriptsCache[findPath(rawPath)] = pageResources
        emitter.emit(`onPostLoadPageResources`, {
          page: pageResources,
          pageResources,
        })
        if (process.env.NODE_ENV === `production`) {
          const pageDataUrl = makePageDataUrl(findPath(rawPath))
          const componentUrls = createComponentUrls(pageData.componentChunkName)
          const resourceUrls = [pageDataUrl].concat(componentUrls)
          onPostPrefetch({
            path: rawPath,
            resourceUrls,
          })
        }

        return pageResources
      })
      .catch(err => null),

  getPage: rawPath => pathScriptsCache[findPath(rawPath)],

  getPage404: rawPath => {
    const page = queue.getPage(rawPath)
    if (page) {
      return page
    } else if (rawPath !== `/404.html`) {
      return queue.getPage(`/404.html`)
    } else {
      return null
    }
  },

  // getResourcesForPathname: rawPath =>
  //   new Promise((resolve, reject) => {
  //     // console.log(`getResourcesForPathname: [${rawPath}]`)
  //     // // Production code path
  //     // if (failedPaths[rawPath]) {
  //     //   handleResourceLoadError(
  //     //     rawPath,
  //     //     `Previously detected load failure for "${rawPath}"`
  //     //   )
  //     //   reject()
  //     //   return
  //     // }

  //     const realPath = findPath(rawPath)
  //     console.log(`real path is [${realPath}]`)

  //     if (!fetchedPageData[realPath]) {
  //       console.log(`Requesting page data for [${realPath}] for first time`)
  //       fetchPageData(realPath).then(() =>
  //         resolve(queue.getResourcesForPathname(rawPath))
  //       )
  //       return
  //     }

  //     const pageData = pageDatas[realPath]

  //     if (!pageData) {
  //       if (shouldFallbackTo404Resources(realPath)) {
  //         console.log(`No page found: [${rawPath}]`)

  //         // Preload the custom 404 page
  //         resolve(queue.getResourcesForPathname(`/404.html`))
  //         return
  //       }

  //       resolve()
  //       return
  //     }

  //     // Check if it's in the cache already.
  //     if (pathScriptsCache[realPath]) {
  //       const pageResources = pathScriptsCache[realPath]
  //       emitter.emit(`onPostLoadPageResources`, {
  //         page: pageResources,
  //         pageResources: pathScriptsCache[realPath],
  //       })
  //       resolve(pageResources)
  //       return
  //     }

  //     // TODO
  //     // Nope, we need to load resource(s)
  //     emitter.emit(`onPreLoadPageResources`, {
  //       path: realPath,
  //     })

  //     const { componentChunkName } = pageData

  //     const finalResolve = component => {
  //       const page = {
  //         componentChunkName: pageData.componentChunkName,
  //         path: pageData.path,
  //         compilationHash: pageData.compilationHash,
  //       }

  //       const jsonData = {
  //         data: pageData.data,
  //         pageContext: pageData.pageContext,
  //       }

  //       const pageResources = {
  //         component,
  //         json: jsonData,
  //         page,
  //       }

  //       // Add to the cache.
  //       pathScriptsCache[realPath] = pageResources
  //       resolve(pageResources)

  //       emitter.emit(`onPostLoadPageResources`, {
  //         page,
  //         pageResources,
  //       })
  //     }

  //     if (process.env.NODE_ENV !== `production`) {
  //       // Ensure latest version of page data is in the JSON store
  //       devGetPageData(realPath)
  //       const component = syncRequires.components[pageData.componentChunkName]
  //       finalResolve(component)
  //     } else {
  //       console.log(`getting page component: [${componentChunkName}]`)
  //       cachedFetch(componentChunkName, fetchComponent)
  //         .then(preferDefault)
  //         .then(component => {
  //           console.log(`got component`)
  //           if (!component) {
  //             resolve(null)
  //             return
  //           }
  //           finalResolve(component)
  //           // Tell plugins the path has been successfully prefetched
  //           const pageDataUrl = makePageDataUrl(realPath)
  //           const componentUrls = createComponentUrls(componentChunkName)
  //           const resourceUrls = [pageDataUrl].concat(componentUrls)
  //           onPostPrefetch({
  //             path: rawPath,
  //             resourceUrls,
  //           })
  //         })
  //     }
  //   })
}

export const setApiRunnerForLoader = runner => {
  apiRunner = runner
  disableCorePrefetching = apiRunner(`disableCorePrefetching`)
}

export const publicLoader = {
  getResourcesForPathname: queue.loadPage,
  getResourcesForPathnameSync: queue.getPage,
  loadPage: queue.loadPage,
  getPage: queue.getPage,
  getPage404: queue.getPage404,
}

export default queue
