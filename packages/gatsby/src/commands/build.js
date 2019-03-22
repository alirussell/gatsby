/* @flow */

const report = require(`gatsby-cli/lib/reporter`)
const buildHtml = require(`./build-html`)
const buildProductionBundle = require(`./build-javascript`)
const bootstrap = require(`../bootstrap`)
const apiRunnerNode = require(`../utils/api-runner-node`)
const { copyStaticDir } = require(`../utils/get-static-dir`)
const { initTracer, stopTracer } = require(`../utils/tracer`)
const chalk = require(`chalk`)
const tracer = require(`opentracing`).globalTracer()
const { emitter, flags } = require(`../redux`)
const db = require(`../db`)
const pageData = require(`../utils/page-data`)

function reportFailure(msg, err: Error) {
  report.log(``)
  report.panic(msg, err)
}

type BuildArgs = {
  directory: string,
  sitePackageJson: object,
  prefixPaths: boolean,
  noUglify: boolean,
  openTracingConfigFile: string,
}

module.exports = async function build(program: BuildArgs) {
  initTracer(program.openTracingConfigFile)

  const buildSpan = tracer.startSpan(`build`)
  buildSpan.setTag(`directory`, program.directory)

  const { graphqlRunner } = await bootstrap({
    ...program,
    parentSpan: buildSpan,
  })

  await apiRunnerNode(`onPreBuild`, {
    graphql: graphqlRunner,
    parentSpan: buildSpan,
  })

  // Copy files from the static directory to
  // an equivalent static directory within public.
  copyStaticDir()

  let activity

  if (flags.isWebpackDirty()) {
    activity = report.activityTimer(
      `Building production JavaScript and CSS bundles`,
      { parentSpan: buildSpan }
    )
    activity.start()
    await buildProductionBundle(program).catch(err => {
      reportFailure(`Generating JavaScript bundles failed`, err)
    })
    activity.end()
  }

  if (flags.renderPageDirty) {
    activity = report.activityTimer(`build render-page.js`, {
      parentSpan: buildSpan,
    })
    activity.start()
    await buildHtml.buildRenderPage()
    activity.end()
  }

  await pageData.waitTillDrained()

  activity = report.activityTimer(`Building static HTML for pages`, {
    parentSpan: buildSpan,
  })
  activity.start()
  await buildHtml.buildDirtyPages(activity).catch(err => {
    reportFailure(
      report.stripIndent`
        Building static HTML failed${
          err.context && err.context.path
            ? ` for path "${chalk.bold(err.context.path)}"`
            : ``
        }

        See our docs page on debugging HTML builds for help https://gatsby.dev/debug-html
      `,
      err
    )
  })
  activity.end()

  await apiRunnerNode(`onPostBuild`, {
    graphql: graphqlRunner,
    parentSpan: buildSpan,
  })

  report.info(`Done building in ${process.uptime()} sec`)
  emitter.emit(`BUILD_FINISHED`)
  await db.saveState()

  buildSpan.finish()

  await stopTracer()
}
