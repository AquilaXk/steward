export class StewardError extends Error {
    constructor(code, message) { super(message); this.name = 'StewardError'; this.code = code; }
}
export function insist(value, code, message) {
    if (!value)
        throw new StewardError(code, message);
}
export function publicError(error) {
    return { code: error instanceof StewardError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof StewardError ? error.message : 'Internal failure. No policy decision was allowed.' };
}
