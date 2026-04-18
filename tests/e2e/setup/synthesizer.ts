export interface OptionsShimInit {
  subcommand?: string;
  values: Record<string, string | number | boolean | unknown>;
}

export interface OptionsShim {
  getSubcommand(required?: boolean): string;
  getString(name: string, required?: boolean): string | null;
  getInteger(name: string, required?: boolean): number | null;
  getBoolean(name: string, required?: boolean): boolean | null;
  getUser(name: string, required?: boolean): unknown;
  getMember(name: string): unknown;
  getChannel(name: string, required?: boolean): unknown;
  getRole(name: string, required?: boolean): unknown;
  getAttachment(name: string, required?: boolean): unknown;
}

export function buildOptionsShim(init: OptionsShimInit): OptionsShim {
  const get = <T>(name: string, required: boolean | undefined, typeLabel: string): T | null => {
    const v = init.values[name];
    if (v === undefined || v === null) {
      if (required) throw new Error(`required option "${name}" (${typeLabel}) not provided`);
      return null;
    }
    return v as T;
  };

  return {
    getSubcommand(required = true) {
      if (!init.subcommand) {
        if (required) throw new Error('no subcommand set on options shim');
        return '';
      }
      return init.subcommand;
    },
    getString: (n, r) => get<string>(n, r, 'string'),
    getInteger: (n, r) => get<number>(n, r, 'integer'),
    getBoolean: (n, r) => get<boolean>(n, r, 'boolean'),
    getUser: (n, r) => get(n, r, 'user'),
    getMember: (n) => get(n, false, 'member'),
    getChannel: (n, r) => get(n, r, 'channel'),
    getRole: (n, r) => get(n, r, 'role'),
    getAttachment: (n, r) => get(n, r, 'attachment'),
  };
}
