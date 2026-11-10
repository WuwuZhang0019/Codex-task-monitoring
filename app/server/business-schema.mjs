import Ajv2020 from 'ajv/dist/2020.js';
import contract from '../mcp/contracts/v1.json' with { type: 'json' };
import { HttpError } from './validation.mjs';

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
ajv.addSchema(contract);
export function requireShape(name, value) {
  const validate = ajv.getSchema(`${contract.$id}#/$defs/${name}`);
  if (!validate || !validate(value)) throw new HttpError(400, `INVALID_INPUT ${name}: ${ajv.errorsText(validate?.errors)}`);
  return value;
}
