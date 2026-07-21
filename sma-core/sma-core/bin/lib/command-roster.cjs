'use strict';
/**
 * Command Roster Module
 *
 * Read-only helper for discovering canonical commands/sma command stems and
 * applying the shared SMA slash-command namespace transform.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const slashCommandTransformer = require('../../../scripts/fix-slash-commands.cjs');
function readSmaCommandNames() {
    return slashCommandTransformer.readCmdNames();
}
module.exports = {
    readSmaCommandNames,
    transformContentToHyphen: slashCommandTransformer.transformContentToHyphen,
    transformContent: slashCommandTransformer.transformContent,
    buildPattern: slashCommandTransformer.buildPattern,
    buildColonPattern: slashCommandTransformer.buildColonPattern,
};
