'use strict'

const { joiCG } = require('../helpers')
const { filter } = require('../../handlers/filterHandlers')
const { pathSchema } = require('../helpers')

module.exports = router => {
  const bodyDesc =
    'The path pattern to pick nodes whose states should be returned, and the filter expression to apply on them.'
  const reqBodySchema = joiCG
    .object()
    .keys({
      path: pathSchema,
      filter: joiCG.string().filter().required()
    })
    .optionalKeys('filter')

  buildEndpoint(router.post('/filter', processFilterRequest, 'filterPost'))
    .body(reqBodySchema, `${bodyDesc}  (e.g. \`{"path": "/c/*raw_data*", "filter": "x == 2 && y < 1"}\`)`)
    .summary('Filter node states.')

  console.debug('Loaded "filter" routes')
}

function processFilterRequest (req, res) {
  res.status(200).json(filter(req))
}

function buildEndpoint (endpoint) {
  return endpoint
    .queryParam(
      'timestamp',
      joiCG
        .number()
        .precision(5)
        .optional(),
      'The unix timestamp (sec) for which to filter node states. Precision: 10μs. Example: since=1547560124.43204.' +
      ' Default: Current Time'
    )
    .queryParam(
      'sort',
      joiCG
        .string()
        .valid('asc', 'desc')
        .optional(),
      'The sort order of records in the result set. Sorts by node ID in the given the sort direction. Default: "asc".'
    )
    .queryParam(
      'preSkip',
      joiCG
        .number()
        .integer()
        .min(0)
        .optional(),
      'The number records to skip/omit from the intermediate result set (after path match, before filter), starting' +
      ' from the first. Falsey implies none.'
    )
    .queryParam(
      'preLimit',
      joiCG
        .number()
        .integer()
        .min(0)
        .optional(),
      'The number records to keep in the intermediate result set (after path match, before filter), starting from' +
      ' "skip"/0. Falsey implies all.'
    )
    .response(200, ['application/json'], 'The states were successfully generated and filtered.')
    .error(500, 'The operation failed.')
    .description(
      'Returns past states for nodes matching the given path pattern and the sorting/slicing constraints and filters.'
    )
    .tag('History')
}
