import { Grammar, accept, s, Productor, ParsingError, Input } from 'iberis'
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
    if (parsed.prefix === null && !parsed.appel && !parsed.hasMention) {
      const prefixes = session.resolve(ctx.root.config.prefix)
      if (prefixes.length !== 0) return
    }
    let content = parsed.prefix
      ? parsed.content.slice(parsed.prefix.length)
      : parsed.content
    if (session.quote) {
      content += ` '${session.quote.content.replace(/'/g, "\\'")}'`
    }
    try {
      const nodes = grammar.parse(s.lexer(content), s.equals)
      if (nodes.length !== 1) return
      session.argv = { args: [], options: {}, session }
      accept(nodes[0], session.argv)
    } catch (e) {
      if (!(e instanceof ParsingError<string | RegExp>)) {
        throw e
      }
    }
  }, true)
}

function update(ctx: Context): Grammar<string | RegExp, Argv> {
  const cmds = ctx.root.$commander._commands._commandList
  const g = new Grammar<string | RegExp, Argv>('root')
  const strip = (replace: string) => {
    return ({ text }: Input) => {
      return text
        .substring(1, text.length - 1)
        .replace(new RegExp(`\\\\${replace}`, 'g'), replace)
    }
  }
  g.p('quote').t(/"(?:[^"\\]|\\.)*"/).bind(strip('"'))
  g.p('quote').t(/'(?:[^'\\]|\\.)*'/).bind(strip("'"))
  g.p('quote').t(/“(?:[^”\\]|\\.)*”/).bind(strip('”'))
  g.p('quote').t(/‘(?:[^’\\]|\\.)*’/).bind(strip('’'))
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
      addTypeTerm(g, g.p(`${name}_args_${i}_factor`), argument.type, (value, argv) => {
        // TODO: check prior arg
        argv.args[i] = value
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
        addTypeTerm(g, g.p(`${name}_option`).t(/-|(--)/).t(optionName), decl.type, (value, argv) => {
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
        addTypeTerm(g, g.p(`${name}_option`).t(symbol), decl.type, (value, argv) => {
          argv[decl.name] = value
        })
      }
    }
  }
  ctx.emit('command/grammar-update', g)
  return g
}

// TODO: add quote for all types
function addTypeTerm<P extends unknown[]>(
  g: Grammar<string | RegExp, Argv>,
  productor: Productor<string | RegExp, Argv, P>,
  type: Argv.Type,
  accept: (value: any, argv: Argv) => void,
) {
  const name = `${productor.name}_type`
  productor.n(name)
  if (!type || type === 'string') {
    g.p(name).n('quote').bind(accept)
    g.p(name).t(/(?!['"“])\S+/).bind(({ text }, argv) => {
      accept(segment.escape(text), argv)
    })
  } else if (typeof type === 'function') {
    g.p(name).t(/(?!['"“])\S+/).bind(({ text }, argv) => {
      accept(type(text, argv.session), argv)
    })
    g.p(name).n('quote').bind((text, argv) => {
      accept(type(text, argv.session), argv)
    })
  } else if (type === 'text') {
    g.p(name).n('quote').bind(accept)
    g.p(name).t(/(?!['"“]).+/).bind(({ text }, argv) => {
      accept(segment.escape(text), argv)
    })
  } else if (type === 'rawtext') {
    g.p(name).n('quote').bind(accept)
    g.p(name).t(/(?!['"“]).+/).bind(({ text }, argv) => accept(text, argv))
  } else if (type === 'number') {
    // negative is conflict with option
    // set it as a standalone term
    g.p(name).t(/[+-]/).t(/\d+(\.\d+)?/).bind(({ text: operator }, { text: number }, argv) => {
      accept(operator === '-' ? -number : +number, argv)
    })
    g.p(name).t(/\d+(\.\d+)?/).bind(({ text }, argv) => {
      accept(+text, argv)
    })
  } else if (type === 'natural' || type === 'integer') {
    g.p(name).t(/[+-]/).t(/\d+/).bind(({ text: operator }, { text: number }, argv) => {
      accept(operator === '-' ? -number : +number, argv)
    })
    g.p(name).t(/\d+/).bind(({ text }, argv) => {
      accept(+text, argv)
    })
  } else if (type === 'posint') {
    g.p(name).t(/\+?\d+/).bind(({ text }, argv) => {
      accept(+text, argv)
    })
  } else if (type === 'user') {
    g.p(name).t(/@\S+/).bind(({ text }, argv) => {
      const segments = text.substring(1).split(':')
      if (segments.length >= 2) {
        accept(segments.join(':'), argv)
      } else if (segments.length !== 0) {
        accept(`${argv.session.platform}:${segments[0]}`, argv)
      } else {
        throw new Error('invalid user type')
      }
    })
  } else if (type === 'channel') {
    g.p(name).t(/#\S+/).bind(({ text }, argv) => {
      const segments = text.substring(1).split(':')
      if (segments.length >= 2) {
        accept(segments.join(':'), argv)
      } else if (segments.length !== 0) {
        accept(`${argv.session.platform}:${segments[0]}`, argv)
      } else {
        throw new Error('invalid channel type')
      }
    })
  } else if (type instanceof RegExp) {
    g.p(name).t(type).bind(({ text }, argv) => {
      accept(text, argv)
    })
  } else {
    logger.warn(`${type}: currently not supported`)
  }
}
