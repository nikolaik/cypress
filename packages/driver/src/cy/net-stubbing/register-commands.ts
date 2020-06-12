import _ from 'lodash'

import {
  RouteHandler,
  RouteMatcherOptions,
  RouteMatcher,
  StaticResponse,
  HttpRequestInterceptor,
  STRING_MATCHER_FIELDS,
  DICT_STRING_MATCHER_FIELDS,
  AnnotatedRouteMatcherOptions,
  AnnotatedStringMatcher,
  NetEventFrames,
  StringMatcher,
  NumberMatcher,
  GenericStaticResponse,
} from '@packages/net-stubbing/lib/types'
import {
  validateStaticResponse,
  getBackendStaticResponse,
} from './static-response-utils'
import { registerEvents } from './events'
import $errUtils from '../../cypress/error_utils'

const STATIC_RESPONSE_KEYS: (keyof GenericStaticResponse<void>)[] = ['body', 'fixture', 'statusCode', 'headers', 'destroySocket']

/**
 * Get all STRING_MATCHER_FIELDS paths plus any extra fields the user has added within
 * DICT_STRING_MATCHER_FIELDS objects
 */
function getAllStringMatcherFields (options: RouteMatcherOptions): string[] {
  return STRING_MATCHER_FIELDS
  .concat(
    // add the nested DictStringMatcher values to the list of fields to annotate
    _.flatten(
      _.filter(
        DICT_STRING_MATCHER_FIELDS.map((field) => {
          const value = options[field]

          if (value) {
            return _.keys(value).map((key) => {
              return `${field}.${key}`
            })
          }

          return ''
        }),
      ),
    ),
  )
}

/**
 * Annotate non-primitive types so that they can be passed to the backend and re-hydrated.
 */
function annotateMatcherOptionsTypes (options: RouteMatcherOptions) {
  const ret: AnnotatedRouteMatcherOptions = {}

  getAllStringMatcherFields(options).forEach((field) => {
    const value = _.get(options, field)

    if (value) {
      _.set(ret, field, {
        type: (isRegExp(value)) ? 'regex' : 'glob',
        value: value.toString(),
      } as AnnotatedStringMatcher)
    }
  })

  const noAnnotationRequiredFields = ['https', 'port', 'webSocket']

  _.extend(ret, _.pick(options, noAnnotationRequiredFields))

  return ret
}

function getUniqueId () {
  return `${Number(new Date()).toString()}-${_.uniqueId()}`
}

function isHttpRequestInterceptor (obj): obj is HttpRequestInterceptor {
  return typeof obj === 'function'
}

function isRegExp (obj): obj is RegExp {
  return obj && (obj instanceof RegExp || obj.__proto__ === RegExp.prototype || obj.__proto__.constructor.name === 'RegExp')
}

function isStringMatcher (obj): obj is StringMatcher {
  return isRegExp(obj) || _.isString(obj)
}

function isNumberMatcher (obj): obj is NumberMatcher {
  return Array.isArray(obj) ? _.every(obj, _.isNumber) : _.isNumber(obj)
}

function validateRouteMatcherOptions (routeMatcher: RouteMatcherOptions): void {
  if (_.isEmpty(routeMatcher)) {
    throw new Error('The RouteMatcher does not contain any keys. You must pass something to match on.')
  }

  getAllStringMatcherFields(routeMatcher).forEach((path) => {
    const v = _.get(routeMatcher, path)

    if (_.has(routeMatcher, path) && !isStringMatcher(v)) {
      throw new Error(`\`${path}\` must be a string or a regular expression.`)
    }
  })

  if (_.has(routeMatcher, 'https') && !_.isBoolean(routeMatcher.https)) {
    throw new Error('`https` must be a boolean.')
  }

  if (_.has(routeMatcher, 'port') && !isNumberMatcher(routeMatcher.port)) {
    throw new Error('`port` must be a number or a list of numbers.')
  }
}

export function registerCommands (Commands, Cypress: Cypress.Cypress, cy: Cypress.cy, state: Cypress.State) {
  const { emitNetEvent } = registerEvents(Cypress)

  function getNewRouteLog (matcher: RouteMatcherOptions, isStubbed: boolean, alias: string | void, staticResponse?: StaticResponse) {
    let obj: Partial<Cypress.LogConfig> = {
      name: 'route',
      instrument: 'route',
      isStubbed,
      numResponses: 0,
      response: staticResponse ? (staticResponse.body || '< empty body >') : (isStubbed ? '< callback function >' : '< passthrough >'),
      consoleProps: () => {
        return {
          Method: obj.method,
          URL: obj.url,
          Status: obj.status,
          'Route Matcher': matcher,
          'Static Response': staticResponse,
          Alias: alias,
        }
      },
    }

    ;['method', 'url'].forEach((k) => {
      if (matcher[k]) {
        obj[k] = String(matcher[k]) // stringify RegExp
      } else {
        obj[k] = '*'
      }
    })

    if (staticResponse) {
      if (staticResponse.statusCode) {
        obj.status = staticResponse.statusCode
      } else {
        obj.status = 200
      }

      if (staticResponse.body) {
        obj.response = staticResponse.body
      } else {
        obj.response = '<empty body>'
      }
    }

    if (!obj.response) {
      if (isStubbed) {
        obj.response = '<callback function'
      } else {
        obj.response = '<passthrough>'
      }
    }

    if (alias) {
      obj.alias = alias
    }

    return Cypress.log(obj)
  }

  function addRoute (matcher: RouteMatcherOptions, handler?: RouteHandler) {
    const handlerId = getUniqueId()

    const alias = cy.getNextAlias()

    const frame: NetEventFrames.AddRoute = {
      handlerId,
      routeMatcher: annotateMatcherOptionsTypes(matcher),
    }

    let staticResponse: StaticResponse | undefined = undefined

    switch (true) {
      case isHttpRequestInterceptor(handler):
        break
      case _.isUndefined(handler):
        // user is doing something like cy.route2('foo').as('foo') to wait on a URL
        break
      case _.isString(handler):
        staticResponse = { body: <string>handler }
        break
      case _.isObjectLike(handler):
        if (!_.intersection(_.keys(handler), STATIC_RESPONSE_KEYS).length && !_.isEmpty(handler)) {
          // the user has not supplied any of the StaticResponse keys, assume it's a JSON object
          handler = {
            body: JSON.stringify(handler),
            headers: {
              'content-type': 'application/json',
            },
          }
        }

        try {
          validateStaticResponse(<StaticResponse>handler)
        } catch (err) {
          return $errUtils.throwErrByPath('net_stubbing.invalid_static_response', { args: { err, staticResponse: handler } })
        }

        staticResponse = handler as StaticResponse
        break
      default:
        return $errUtils.throwErrByPath('net_stubbing.invalid_handler', { args: { handler } })
    }

    if (staticResponse) {
      frame.staticResponse = getBackendStaticResponse(staticResponse)
    }

    state('routes')[handlerId] = {
      log: getNewRouteLog(matcher, !!handler, alias, staticResponse),
      options: matcher,
      handler,
      hitCount: 0,
      requests: {},
    }

    if (alias) {
      state('routes')[handlerId].alias = alias
    }

    return emitNetEvent('route:added', frame)
  }

  function route2 (matcher: RouteMatcher, handler?: RouteHandler | StringMatcher, arg2?: RouteHandler) {
    if (!Cypress.config('experimentalNetworkMocking')) {
      return $errUtils.throwErrByPath('net_stubbing.route2_needs_experimental')
    }

    function getMatcherOptions (): RouteMatcherOptions {
      if (_.isString(matcher) && isStringMatcher(handler) && arg2) {
        // method, url, handler
        const url = handler as StringMatcher

        handler = arg2

        return {
          method: matcher,
          url,
        }
      }

      if (isStringMatcher(matcher)) {
        // url, handler
        return {
          url: matcher,
        }
      }

      return matcher
    }

    const routeMatcherOptions = getMatcherOptions()

    try {
      validateRouteMatcherOptions(routeMatcherOptions)
    } catch (err) {
      $errUtils.throwErrByPath('net_stubbing.invalid_route_matcher', { args: { err, matcher: routeMatcherOptions } })
    }

    return addRoute(routeMatcherOptions, handler as RouteHandler)
    .then(() => null)
  }

  Commands.addAll({
    route2,
  })
}
