const { parentPort } = require('worker_threads');
const pl = require('tau-prolog');

const termToValue = (term) => {
    if (pl.type.is_number(term)) return term.value;
    if (pl.type.is_empty_list(term)) return [];
    if (pl.type.is_non_empty_list(term)) {
        const values = [];
        let current = term;
        while (pl.type.is_non_empty_list(current)) {
            values.push(termToValue(current.args[0]));
            current = current.args[1];
        }
        if (!pl.type.is_empty_list(current)) {
            values.push(termToValue(current));
        }
        return values;
    }
    if (pl.type.is_atom(term)) return term.id;
    if (pl.type.is_compound(term)) {
        return {
            functor: term.id,
            args: term.args.map(termToValue)
        };
    }
    return term?.id ?? null;
};

parentPort.on('message', ({ jobId, program, query, variables }) => {
    let settled = false;
    const sendError = (error) => {
        if (settled) return;
        settled = true;
        parentPort.postMessage({
            jobId,
            error: error instanceof Error ? error.message : String(error)
        });
    };

    try {
        const session = pl.create();
        session.consult(program, {
            success: () => {
                session.query(query, {
                    success: () => {
                        session.answer(answer => {
                            if (settled) return;
                            if (pl.type.is_error(answer)) {
                                sendError(new Error(pl.format_answer(answer)));
                                return;
                            }
                            settled = true;
                            const bindings = pl.type.is_substitution(answer)
                                ? Object.fromEntries(variables.map(name => [
                                    name,
                                    termToValue(answer.lookup(name))
                                ]))
                                : null;
                            parentPort.postMessage({ jobId, bindings });
                        });
                    },
                    error: sendError
                });
            },
            error: sendError
        });
    } catch (error) {
        sendError(error);
    }
});
