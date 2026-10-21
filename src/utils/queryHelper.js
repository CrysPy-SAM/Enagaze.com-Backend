/**
 * Safe lean query wrapper that handles both real Mongoose queries and test mocks
 * where terminal query methods return raw Promises or objects without .lean().
 *
 * @param {any} query
 * @returns {any}
 */
export const safeLean = (query) => {
    if (query && typeof query.lean === "function") {
        return query.lean();
    }
    return query;
};

