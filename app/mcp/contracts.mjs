import Ajv2020 from 'ajv/dist/2020.js';
import contractSchema from './contracts/v1.json' with { type: 'json' };

export const contract = contractSchema;
// Conditional branches reference fields declared on the enclosing object.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
ajv.addSchema(contract);

export function schemaFor(tool, direction) {
  const definition = contract.$defs[`${tool}_${direction}`];
  if (!definition) throw new Error('Unknown workbench contract');
  return { $schema: contract.$schema, ...definition, $defs: contract.$defs };
}

export function validatorFor(tool, direction) {
  return ajv.getSchema(`${contract.$id}#/$defs/${tool}_${direction}`);
}
