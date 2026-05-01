import { type DescExtension, type DescField, type DescMessage } from "@bufbuild/protobuf";
import type { GeneratedFile, Printable } from "@bufbuild/protoplugin";
/**
 * Returns a type expression for `GenMessage` from @bufbuild/protobuf/codegenv2,
 * with the mandatory `RuntimeShape` parameter, and the optional `OptShapes`
 * parameter providing a JSON type, and/or a Valid type.
 *
 * For example:
 * - `GenMessage<Example>`
 * - `GenMessage<Example, {jsonType: ExampleJson}>`
 * - `GenMessage<Example, {validType: ExampleValid}>`
 * - `GenMessage<Example, {jsonType: ExampleJson, validType: ExampleValid}>`
 */
export declare function messageGenType(desc: DescMessage, f: GeneratedFile, options: {
    jsonTypes: boolean;
    validTypes: {
        legacyRequired: boolean;
        protovalidateRequired: boolean;
    };
}): Printable;
export declare function fieldTypeScriptType(field: DescField | DescExtension, imports: GeneratedFile["runtime"], validTypes?: boolean): {
    typing: Printable;
    optional: boolean;
};
export declare function fieldJsonType(field: DescField | DescExtension): Printable;
export declare function functionCall(fn: Printable, args: Printable[], typeParams?: Printable[]): Printable;
