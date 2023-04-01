import { Computed, Context, Schema } from 'koishi'

interface Config {
  prefix: Computed<string[]>
}

export const name = 'command'

export const Config: Schema<Config> = Schema.object({
  prefix: Schema.computed(Schema.array(Schema.string())),
})

export function apply(ctx: Context, config: Config) {
  ctx.on('command-added', () => update(ctx))
  update(ctx)
  ctx.middleware((session, next) => {
    return next()
  })
}

function update(ctx: Context) {
  const cmds = ctx.root.$commander._commands
}