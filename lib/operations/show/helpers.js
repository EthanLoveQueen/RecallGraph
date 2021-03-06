'use strict'

const { db, aql } = require('@arangodb')
const {
  getScopeInitializers,
  getSort,
  getNonServiceCollections,
  getLimitClause,
  getDBScope,
  getMatchingCollNames,
  getNodeBraceScope: getOpNodeBraceScope
} = require('../helpers')
const { SERVICE_COLLECTIONS, COLLECTION_TYPES, getCollectionType, SERVICE_GRAPHS } = require('../../helpers')
const minimatch = require('minimatch')
const expand = require('brace-expansion')
const { chain, isString, find, difference, values } = require('lodash')
const jiff = require('jiff')
const gg = require('@arangodb/general-graph')

const COLL_TYPES_REF = Object.freeze(
  chain(COLLECTION_TYPES).map((idx, label) => [idx, label.toLowerCase()]).fromPairs().value())
exports.COLL_TYPES_REF = COLL_TYPES_REF

const CLAUSE_FLAGS = Object.freeze({
  '+g+c': ['ac', 'slc'],
  '+g-c': ['qs', 'ac', 'slc'],
  '-g+c': ['ac'],
  '-g-c': ['slc', 'qs']
})
const GROUP_BY = Object.freeze({
  TYPE: 'collTypes[parse_identifier(ne.node).collection]',
  COLLECTION: 'parse_identifier(ne.node).collection'
})

const commandColl = db._collection(SERVICE_COLLECTIONS.commands)
const evtSSLinkColl = db._collection(SERVICE_COLLECTIONS.evtSSLinks)
const snapshotLinkColl = db._collection(SERVICE_COLLECTIONS.snapshotLinks)

function getScopeFilters (scope, searchPattern) {
  return scope.filters ? scope.filters(searchPattern) : aql.literal('')
}

function getGroupExpr (groupByKey) {
  return isString(groupByKey) && GROUP_BY[groupByKey.toUpperCase()]
}

function getShowQueryPrefix (timestamp, scope, searchPattern) {
  const queryParts = [
    aql`
      let nodeEvents = (
        for e in evstore_events
    `,
    getScopeFilters(scope, searchPattern),
    aql`
          filter e['hops-from-origin'] > 0
    `
  ]

  if (timestamp) {
    queryParts.push(aql`filter e.ctime <= ${timestamp}`)
  }

  queryParts.push(
    aql`
          sort e['hops-from-origin'] desc
          collect node = e.meta.id into events = e
        return {
          node,
          latest_event: events[0]
        }
      )
      for ne in nodeEvents
        filter ne.latest_event.event != 'deleted'
     `
  )

  return queryParts
}

function getShowQuerySuffix (groupExpr, groupSort) {
  const queryParts = [
    aql`
      let path = (
        for v, e in any shortest_path
        ne.latest_event['last-snapshot'] to ne.latest_event._id
        ${commandColl}, ${evtSSLinkColl}, outbound ${snapshotLinkColl}
        return {hop: keep(v, '_id', 'data'), command: ((e || {}).command || [])}
      )
    `
  ]

  if (groupExpr) {
    const groupSortDir = getSort(groupSort)
    queryParts.unshift(aql`sort ne.node ${groupSortDir}`)
  }

  return queryParts
}

function getCollTypes () {
  const collTypes = {}
  const nonServiceCollections = getNonServiceCollections()

  for (const coll of nonServiceCollections) {
    collTypes[coll] = COLL_TYPES_REF[getCollectionType(coll)]
  }

  return collTypes
}

exports.getCollTypes = getCollTypes

function getCollTypeInitializer () {
  const collTypes = getCollTypes()

  return aql`let collTypes = ${collTypes}`
}

function getAggregationClause (groupBy, countsOnly) {
  const groupExpr = getGroupExpr(groupBy)
  const groupingPrefix = groupExpr ? `collect ${groupBy} = ${groupExpr} ` : countsOnly ? 'collect ' : ''
  const groupingSuffix = countsOnly ? 'with count into total' : groupExpr ? 'into paths = path' : ''

  return aql.literal(`${groupingPrefix}${groupingSuffix}`)
}

function getSortingClause (sort, groupBy, countsOnly) {
  const sortDir = getSort(sort)
  const groupExpr = getGroupExpr(groupBy)
  const sortPrefix = (groupExpr || !countsOnly) ? 'sort ' : ''
  const primarySort = !sortPrefix ? '' : (countsOnly ? 'total' : groupExpr ? groupBy : 'ne.node') + ` ${sortDir}`
  const secondarySort = primarySort && groupExpr && countsOnly ? `, ${groupBy} asc` : ''

  return aql.literal(`${sortPrefix}${primarySort}${secondarySort}`)
}

function getReturnClause (
  groupBy,
  countsOnly,
  groupSkip,
  groupLimit
) {
  const groupExpr = getGroupExpr(groupBy)
  let returnClause

  if (groupExpr) {
    if (countsOnly) {
      returnClause = aql.literal(`return {${groupBy}, total}`)
    } else {
      const queryParts = [
        aql.literal(`return {${groupBy}, paths`)
      ]
      if (groupLimit) {
        queryParts.push(aql`: paths[* ${getLimitClause(groupLimit, groupSkip)}]`)
      }
      queryParts.push(aql.literal('}'))

      returnClause = aql.join(queryParts, '')
    }
  } else if (countsOnly) {
    returnClause = aql.literal(
      'return {total}'
    )
  } else {
    returnClause = aql.literal(
      'return path'
    )
  }

  return returnClause
}

function getScopeAndSearchPatternFor (path) {
  const collections = getNonServiceCollections()
  const scopes = getAvailableScopes(collections)

  const scope = find(scopes, scope => minimatch(path, scope.pathPattern))
  const searchPattern = scope.prefix ? path.substring(scope.prefix.length) : path

  return { scope, searchPattern }
}

function getAvailableScopes (collections) {
  return {
    database: getDBScope(),
    graph: getGraphScope(),
    collection: getCollectionScope(collections),
    nodeGlob: getNodeGlobScope(),
    nodeExact: getNodeBraceScope(collections)
  }
}

function getGraphScope () {
  return {
    pathPattern: '/g/*',
    prefix: '/g/',
    filters: searchPattern => {
      const graphNames = difference(gg._list(), values(SERVICE_GRAPHS))
      const matches = minimatch.match(graphNames, searchPattern)
      const collNames = getMatchingCollNames(matches)

      return aql`filter parse_identifier(e.meta.id).collection in ${collNames}`
    }
  }
}

function getCollectionScope (collections) {
  return {
    pathPattern: '/c/*',
    prefix: '/c/',
    filters: searchPattern => {
      const matches = minimatch.match(collections, searchPattern)

      return aql`filter parse_identifier(e.meta.id).collection in ${matches}`
    }
  }
}

function getNodeGlobScope () {
  return {
    pathPattern: '/ng/**',
    prefix: '/ng/',
    filters: searchPattern => {
      const idPattern = minimatch.makeRe(searchPattern).source

      return aql`filter regex_test(e.meta.id, ${idPattern})`
    }
  }
}

function getNodeBraceScope (collections) {
  return {
    pathPattern: '/n/**',
    prefix: '/n/',
    filters: searchPattern => {
      const collMatches = chain(expand(searchPattern))
        .map(pattern => pattern.split('/')[0])
        .intersection(collections)
        .value()

      return aql`
        let collName = parse_identifier(e.meta.id).collection
        filter collName in ${collMatches}
        filter e.meta.id in idGroups[collName]
      ` // See initializers below for idGroups definition.
    },
    initializers: getOpNodeBraceScope(collections).initializers
  }
}

exports.buildShowQuery = function buildShowQuery ({ path, timestamp, sort, skip, limit, groupBy, countsOnly, groupSort, groupSkip, groupLimit }) {
  const { scope, searchPattern } = getScopeAndSearchPatternFor(path)
  const queryParts = [
    getCollTypeInitializer(),
    getScopeInitializers(scope, searchPattern),
    ...getShowQueryPrefix(timestamp, scope, searchPattern)
  ]
  const groupExpr = getGroupExpr(groupBy)
  const clauseFlag = (groupExpr ? '+g' : '-g') + (countsOnly ? '+c' : '-c')
  const sequence = CLAUSE_FLAGS[clauseFlag]
  const clauseMap = {
    ac: () => [getAggregationClause(groupBy, countsOnly)],
    slc: () => [getSortingClause(sort, groupBy, countsOnly), getLimitClause(limit, skip)],
    qs: () => getShowQuerySuffix(groupExpr, groupSort)
  }

  for (let clauseKey of sequence) {
    queryParts.push(...clauseMap[clauseKey]())
  }

  queryParts.push(getReturnClause(groupBy, countsOnly, groupSkip, groupLimit))

  return aql.join(queryParts, '\n')
}

exports.patch = function patch (paths) {
  const nodes = []
  for (let p of paths) {
    let diffs = []
    const startingIdx = p[1].hop._id.startsWith(SERVICE_COLLECTIONS.snapshots) ? 1 : 0
    const startingNode = p[startingIdx].hop.data

    for (let i = startingIdx + 2; i < p.length; i++) {
      diffs.push(p[i].command)
    }

    if (startingIdx === 1) {
      // Reverse the individual diffs
      diffs = diffs.map(c => jiff.inverse(c))
    }

    let node = startingNode
    for (let d of diffs) {
      node = jiff.patch(d, node, {})
    }

    nodes.push(node)
  }

  return nodes
}
