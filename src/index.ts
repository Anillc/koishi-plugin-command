import { Grammar, accept, s } from 'iberis'
import { Argv, Computed, Context, Schema } from 'koishi'

interface Config {
  prefix: Computed<string[]>
}

export const name = 'command'

export const Config: Schema<Config> = Schema.object({
  prefix: Schema.computed(Schema.array(Schema.string())),
})

export function apply(ctx: Context, config: Config) {
  let grammar = update(ctx)
  ctx.on('command-added', () => grammar = update(ctx))
  ctx.middleware((session, next) => {
    const { content } = session
    const prefixes = session.resolve(config.prefix)
    let body: string
    let bypass = false
    if (!prefixes || prefixes.length === 0) {
      body = content
      bypass = true
    } else {
      for (const prefix of prefixes) {
        if (content.startsWith(prefix)) {
          body = content.substring(prefix.length)
        }
      }
      if (!body) return next()
    }
    const nodes = grammar.parse(s.lexer(body), s.equals)
    if (nodes.length !== 1) {
      if (bypass) {
        return next()
      } else {
        return '未找到指令或指令格式错误。'
      }
    }
    const argv: Argv = { args: [], options: {} }
    accept(nodes[0], argv)
    return session.execute(argv)
  })
}

function update(ctx: Context): Grammar<string | RegExp, Argv> {
  const cmds = ctx.root.$commander._commands._commandList
  const g = new Grammar<string | RegExp, Argv>('cmds')
  for (const cmd of cmds) {
    const { name } = cmd
    g.p('cmds').n(name)
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
      g.p(`${name}_args_${i}_factor`).t(fromType(argument.type))
        .bind(({ text }, argv) => argv.args.push(text))
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
        g.p(`${name}_option`).t(/-|(--)/).t(optionName).t(fromType(decl.type))
          .bind((_1, _2, { text }, argv) => argv.options[decl.name] = text)
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
        g.p(`${name}_option`).t(symbol).t(fromType(decl.type))
          .bind((_, { text }, argv) => argv.options[decl.name] = text)
      }
    }
  }
  return g
}

function fromType(type: Argv.Type) {
  if (type === undefined || type === 'string' || typeof type === 'function') {
    return /\S+/
  } else if (type === 'text' || type === 'rawtext') {
    return /.+/
  } else if (type === 'number') {
    return /[+-]?\d+(\.\d*)?/
  } else if (type === 'natural' || type === 'integer') {
    return /[+-]?\d+/
  } else if (type === 'posint') {
    return /\+?\d+/
  } else if (type === 'user') {
    return /@\S+/
  } else if (type === 'channel') {
    return /#\S+/
  } else if (type instanceof RegExp) {
    return type
  } else {
    throw new Error(`${type}: currently not supported`)
  }
}
