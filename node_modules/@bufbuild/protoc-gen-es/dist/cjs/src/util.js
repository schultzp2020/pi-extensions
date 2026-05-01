"use strict";
// Copyright 2021-2026 Buf Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageGenType = messageGenType;
exports.fieldTypeScriptType = fieldTypeScriptType;
exports.fieldJsonType = fieldJsonType;
exports.functionCall = functionCall;
const protobuf_1 = require("@bufbuild/protobuf");
const codegenv2_1 = require("@bufbuild/protobuf/codegenv2");
const wkt_1 = require("@bufbuild/protobuf/wkt");
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
function messageGenType(desc, f, options) {
    let p2 = [];
    if (options.jsonTypes) {
        p2.push(["jsonType: ", f.importJson(desc)]);
    }
    if (options.validTypes.legacyRequired ||
        options.validTypes.protovalidateRequired) {
        p2.push(["validType: ", f.importValid(desc)]);
    }
    if (p2.length > 0) {
        p2 = [", {", commaSeparate(p2), "}"];
    }
    return [f.runtime.codegen.GenMessage, "<", f.importShape(desc), p2, ">"];
}
function fieldTypeScriptType(field, imports, validTypes = false) {
    const typing = [];
    let optional = false;
    switch (field.fieldKind) {
        case "scalar":
            typing.push((0, codegenv2_1.scalarTypeScriptType)(field.scalar, field.longAsString));
            optional = field.proto.proto3Optional;
            break;
        case "message": {
            typing.push(messageFieldTypeScriptType(field, imports, validTypes));
            optional = true;
            break;
        }
        case "enum":
            typing.push({
                kind: "es_shape_ref",
                desc: field.enum,
            });
            optional = field.proto.proto3Optional;
            break;
        case "list":
            optional = false;
            switch (field.listKind) {
                case "enum":
                    typing.push({
                        kind: "es_shape_ref",
                        desc: field.enum,
                    }, "[]");
                    break;
                case "scalar":
                    typing.push((0, codegenv2_1.scalarTypeScriptType)(field.scalar, field.longAsString), "[]");
                    break;
                case "message": {
                    typing.push(messageFieldTypeScriptType(field, imports, validTypes), "[]");
                    break;
                }
            }
            break;
        case "map": {
            let keyType;
            switch (field.mapKey) {
                case protobuf_1.ScalarType.INT32:
                case protobuf_1.ScalarType.FIXED32:
                case protobuf_1.ScalarType.UINT32:
                case protobuf_1.ScalarType.SFIXED32:
                case protobuf_1.ScalarType.SINT32:
                    keyType = "number";
                    break;
                default:
                    keyType = "string";
                    break;
            }
            let valueType;
            switch (field.mapKind) {
                case "scalar":
                    valueType = (0, codegenv2_1.scalarTypeScriptType)(field.scalar, false);
                    break;
                case "message":
                    valueType = messageFieldTypeScriptType(field, imports, validTypes);
                    break;
                case "enum":
                    valueType = {
                        kind: "es_shape_ref",
                        desc: field.enum,
                    };
                    break;
            }
            typing.push("{ [key: ", keyType, "]: ", valueType, " }");
            optional = false;
            break;
        }
    }
    return { typing, optional };
}
function messageFieldTypeScriptType(field, imports, validTypes) {
    var _a;
    if ((0, wkt_1.isWrapperDesc)(field.message) &&
        !field.oneof &&
        field.fieldKind == "message") {
        const baseType = field.message.fields[0].scalar;
        return (0, codegenv2_1.scalarTypeScriptType)(baseType, false);
    }
    if (field.message.typeName == wkt_1.StructSchema.typeName &&
        ((_a = field.parent) === null || _a === void 0 ? void 0 : _a.typeName) != wkt_1.ValueSchema.typeName) {
        return imports.JsonObject;
    }
    if (validTypes && !(field.message.file.proto.name in codegenv2_1.wktPublicImportPaths)) {
        return {
            kind: "es_valid_type_ref",
            desc: field.message,
        };
    }
    return {
        kind: "es_shape_ref",
        desc: field.message,
    };
}
function fieldJsonType(field) {
    switch (field.fieldKind) {
        case "scalar":
            return (0, codegenv2_1.scalarJsonType)(field.scalar);
        case "message":
            return {
                kind: "es_json_type_ref",
                desc: field.message,
            };
        case "enum":
            return {
                kind: "es_json_type_ref",
                desc: field.enum,
            };
        case "list":
            switch (field.listKind) {
                case "enum":
                    return [
                        {
                            kind: "es_json_type_ref",
                            desc: field.enum,
                        },
                        "[]",
                    ];
                case "scalar": {
                    const t = (0, codegenv2_1.scalarJsonType)(field.scalar);
                    if (t.includes("|")) {
                        return ["(", t, ")[]"];
                    }
                    return [t, "[]"];
                }
                case "message":
                    return [
                        {
                            kind: "es_json_type_ref",
                            desc: field.message,
                        },
                        "[]",
                    ];
            }
            break;
        case "map": {
            let keyType;
            switch (field.mapKey) {
                case protobuf_1.ScalarType.INT32:
                case protobuf_1.ScalarType.FIXED32:
                case protobuf_1.ScalarType.UINT32:
                case protobuf_1.ScalarType.SFIXED32:
                case protobuf_1.ScalarType.SINT32:
                    keyType = "number";
                    break;
                default:
                    keyType = "string";
                    break;
            }
            let valueType;
            switch (field.mapKind) {
                case "scalar":
                    valueType = (0, codegenv2_1.scalarJsonType)(field.scalar);
                    break;
                case "message":
                    valueType = {
                        kind: "es_json_type_ref",
                        desc: field.message,
                    };
                    break;
                case "enum":
                    valueType = {
                        kind: "es_json_type_ref",
                        desc: field.enum,
                    };
                    break;
            }
            return ["{ [key: ", keyType, "]: ", valueType, " }"];
        }
    }
}
function functionCall(fn, args, typeParams) {
    let tp = [];
    if (typeParams !== undefined && typeParams.length > 0) {
        tp = ["<", commaSeparate(typeParams), ">"];
    }
    return [fn, ...tp, "(", commaSeparate(args), ")"];
}
function commaSeparate(elements) {
    const r = [];
    for (let i = 0; i < elements.length; i++) {
        r.push(elements[i]);
        if (i < elements.length - 1) {
            r.push(", ");
        }
    }
    return r;
}
