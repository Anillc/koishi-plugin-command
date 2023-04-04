import { Grammar, accept, s, Productor } from 'iberis'
import { Argv, Context, Logger, segment } from 'koishi'

declare module 'koishi' {
  interface Events {
    'command/grammar-update'(grammar: Grammar<string | RegExp, Argv>): void
  }
}

export const name = 'command'

const logger = new Logger('command')

export function apply(ctx: Context) {
  let grammar = update(ctx)
  ctx.on('command-added', () => grammar = update(ctx))
  ctx.before('attach', async (session) => {
    if (session.argv.name || session.argv.command) return
    const { parsed } = session
    const nodes = grammar.parse(s.lexer(parsed.content), s.equals)
    if (nodes.length !== 1) return
    session.argv = { args: [], options: {}, session }
    accept(nodes[0], session.argv)
  }, true)
}

function update(ctx: Context): Grammar<string | RegExp, Argv> {
  const cmds = ctx.root.$commander._commands._commandList
  const g = new Grammar<string | RegExp, Argv>('root')
  for (const cmd of cmds) {
    const { name } = cmd
    g.p('root').n(name)
    g.p(name).t(name).n(`${name}_command`)
      .bind((_1, _2, argv) => argv.name = name)
    for (const alias of cmd._aliases) {
      g.p(name).t(alias).n(`${name}_command`)
        .bind((_1, _2, argv) => argv.name = name)
    }
    const productor = g.p(`${name}_command`).n(`${name}_options`)
    for (let i = 0; i < cmd._arguments.length; i++) {
      const argument = cmd._arguments[i]
      productor.n(`${name}_args_${i}`).n(`${name}_options`)
      if (!cmd.config.checkArgCount || !argument.required) {
        g.p(`${name}_args_${i}`)
      }
      if (argument.variadic) {
        g.p(`${name}_args_${i}`).n(`${name}_args_${i}_variadic`)
        g.p(`${name}_args_${i}_variadic`).n(`${name}_args_${i}_variadic`).n(`${name}_args_${i}_factor`)
        g.p(`${name}_args_${i}_variadic`).n(`${name}_args_${i}_factor`)
      } else {
        g.p(`${name}_args_${i}`).n(`${name}_args_${i}_factor`)
      }
      addTypeTerm(g.p(`${name}_args_${i}_factor`), argument.type, (value, argv) => {
        argv.args.push(value)
      })
    }
    g.p(`${name}_options`).n(`${name}_options`).n(`${name}_option`)
    g.p(`${name}_options`)
    for (const entry of Object.entries(cmd['_namedOptions'])) {
      const [optionName, decl] = entry as [string, Argv.OptionDeclaration]
      if (decl.type === 'boolean') {
        g.p(`${name}_option`).t(/-|(--)/).t(optionName)
          .bind((_1, _2, argv) => argv.options[decl.name] = true)
      } else {
        if (!decl.required) {
          g.p(`${name}_option`).t(/-|(--)/).t(optionName)
            .bind((_1, _2, argv) => argv.options[decl.name] = true)
        }
        addTypeTerm(g.p(`${name}_option`).t(/-|(--)/).t(optionName), decl.type, (value, argv) => {
          argv.options[decl.name] = value
        })
      }
    }
    for (const entry of Object.entries(cmd['_symbolicOptions'])) {
      const [symbol, decl] = entry as [string, Argv.OptionDeclaration]
      if (decl.type === 'boolean') {
        g.p(`${name}_option`).t(symbol)
          .bind((_, argv) => argv.options[decl.name] = true)
      } else {
        if (!decl.required) {
          g.p(`${name}_option`).t(symbol)
            .bind((_, argv) => argv.options[decl.name] = true)
        }
        addTypeTerm(g.p(`${name}_option`).t(symbol), decl.type, (value, argv) => {
          argv[decl.name] = value
        })
      }
    }
  }
  ctx.emit('command/grammar-update', g)
  return g
}

function addTypeTerm<P extends unknown[]>(
  productor: Productor<string | RegExp, Argv, P>,
  type: Argv.Type,
  accept: (value: any, argv: Argv) => void,
) {
  const resolver = (resolve: (text: string, argv: Argv, args: any[]) => any) => {
    return (...args: any[]) => {
      const { text } = args.at(-2)
      const argv = args.at(-1)
      accept(resolve(text, argv, args), argv)
    }
  }
  if (!type || type === 'string') {
    productor.t(/\S+/).bind(resolver((text) => segment.escape(text)))
  } else if (typeof type === 'function') {
    productor.t(/\S+/).bind(resolver((text, { session }) => type(text, session)))
  } else if (type === 'text') {
    productor.t(/.+/).bind(resolver((text) => segment.escape(text)))
  } else if (type === 'rawtext') {
    productor.t(/.+/).bind(resolver((text) => text))
  } else if (type === 'number') {
    // negative is conflict with option
    // set it as a standalone term
    productor.t(/[+-]?/).t(/\d+(\.\d+)?/).bind(resolver((text, _, args) => {
      return args.at(-3).text === '-' ? -text : +text
    }))
  } else if (type === 'natural' || type === 'integer') {
    productor.t(/[+-]?/).t(/\d+/).bind(resolver((text, _, args) => {
      return args.at(-3).text === '-' ? -text : +text
    }))
  } else if (type === 'posint') {
    productor.t(/\+?\d+/).bind(resolver((text) => +text))
  } else if (type === 'user') {
    productor.t(/@\S+/).bind(resolver((text, { session }) => {
      const segments = text.substring(1).split(':')
      if (segments.length >= 2) {
        return segments.join(':')
      } else if (segments.length !== 0) {
        return `${session.platform}:${segments[0]}`
      } else {
        throw new Error('invalid user type')
      }
    }))
  } else if (type === 'channel') {
    productor.t(/#\S+/).bind(resolver((text, { session }) => {
      const segments = text.substring(1).split(':')
      if (segments.length >= 2) {
        return segments.join(':')
      } else if (segments.length !== 0) {
        return `${session.platform}:${segments[0]}`
      } else {
        throw new Error('invalid channel type')
      }
    }))
  } else if (type instanceof RegExp) {
    productor.t(type).bind(resolver((text) => text))
  } else {
    logger.warn(`${type}: currently not supported`)
  }
}
