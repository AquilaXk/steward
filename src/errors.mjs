export class StewardError extends Error {
    constructor(code, message) { super(message); this.name = 'StewardError'; this.code = code; }
}
export function insist(value, code, message) {
    if (!value)
        throw new StewardError(code, message);
}
export function publicError(error) {
    if (error instanceof StewardError) {
        return { code: error.code, message: error.message };
    }
    if (typeof error?.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_')) {
        return { code: 'USAGE', message: error.message };
    }
    return { code: 'INTERNAL_ERROR', message: 'Internal failure. No policy decision was allowed.' };
}

