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
exports.protocGenEs = void 0;
const reflect_1 = require("@bufbuild/protobuf/reflect");
const codegenv2_1 = require("@bufbuild/protobuf/codegenv2");
const wkt_1 = require("@bufbuild/protobuf/wkt");
const protoplugin_1 = require("@bufbuild/protoplugin");
const util_js_1 = require("./util.js");
const package_json_1 = require("../package.json");
const valid_types_js_1 = require("./valid-types.js");
exports.protocGenEs = (0, protoplugin_1.createEcmaScriptPlugin)({
    name: "protoc-gen-es",
    version: `v${String(package_json_1.version)}`,
    parseOptions,
    generateTs,
    generateJs,
    generateDts,
});
function parseOptions(options) {
    let jsonTypes = false;
    let validTypes = {
        legacyRequired: false,
        protovalidateRequired: false,
    };
    for (const { key, value } of options) {
        switch (key) {
            case "json_types":
                if (!["true", "1", "false", "0"].includes(value)) {
                    throw "please provide true or false";
                }
                jsonTypes = ["true", "1"].includes(value);
                break;
            case "valid_types":
                for (const part of value.split("+")) {
                    switch (part) {
                        case "protovalidate_required":
                            validTypes.protovalidateRequired = true;
                            break;
                        case "legacy_required":
                            validTypes.legacyRequired = true;
                            break;
                        default:
                            throw new Error();
                    }
                }
                break;
            default:
                throw new Error();
        }
    }
    return { jsonTypes, validTypes };
}
// This annotation informs bundlers that the succeeding function call is free of
// side effects. This means the symbol can be removed from the module during
// tree-shaking if it is unused.
// See https://github.com/bufbuild/protobuf-es/pull/470
const pure = "/*@__PURE__*/";
// biome-ignore format: want this to read well
function generateTs(schema) {
    for (const file of schema.files) {
        const f = schema.generateFile(file.name + "_pb.ts");
        f.preamble(file);
        const { GenFile } = f.runtime.codegen;
        const fileDesc = f.importSchema(file);
        generateDescDoc(f, file);
        f.print(f.export("const", fileDesc.name), ": ", GenFile, " = ", pure);
        f.print("  ", getFileDescCall(f, file, schema), ";");
        f.print();
        for (const desc of schema.typesInFile(file)) {
            switch (desc.kind) {
                case "message": {
                    generateMessageShape(f, desc, "ts");
                    if (schema.options.jsonTypes) {
                        generateMessageJsonShape(f, desc, "ts");
                    }
                    if (schema.options.validTypes.legacyRequired || schema.options.validTypes.protovalidateRequired) {
                        generateMessageValidShape(f, desc, schema.options.validTypes, "ts");
                    }
                    generateDescDoc(f, desc);
                    const name = f.importSchema(desc).name;
                    f.print(f.export("const", name), ": ", (0, util_js_1.messageGenType)(desc, f, schema.options), " = ", pure);
                    const call = (0, util_js_1.functionCall)(f.runtime.codegen.messageDesc, [fileDesc, ...(0, codegenv2_1.pathInFileDesc)(desc)]);
                    f.print("  ", call, ";");
                    f.print();
                    break;
                }
                case "enum": {
                    generateEnumShape(f, desc);
                    if (schema.options.jsonTypes) {
                        generateEnumJsonShape(f, desc, "ts");
                    }
                    generateDescDoc(f, desc);
                    const name = f.importSchema(desc).name;
                    const Shape = f.importShape(desc);
                    const { GenEnum, enumDesc } = f.runtime.codegen;
                    if (schema.options.jsonTypes) {
                        const JsonType = f.importJson(desc);
                        f.print(f.export("const", name), ": ", GenEnum, "<", Shape, ", ", JsonType, ">", " = ", pure);
                    }
                    else {
                        f.print(f.export("const", name), ": ", GenEnum, "<", Shape, ">", " = ", pure);
                    }
                    const call = (0, util_js_1.functionCall)(enumDesc, [fileDesc, ...(0, codegenv2_1.pathInFileDesc)(desc)]);
                    f.print("  ", call, ";");
                    f.print();
                    break;
                }
                case "extension": {
                    const { GenExtension, extDesc } = f.runtime.codegen;
                    const name = f.importSchema(desc).name;
                    const E = f.importShape(desc.extendee);
                    const V = (0, util_js_1.fieldTypeScriptType)(desc, f.runtime).typing;
                    const call = (0, util_js_1.functionCall)(extDesc, [fileDesc, ...(0, codegenv2_1.pathInFileDesc)(desc)]);
                    f.print(f.jsDoc(desc));
                    f.print(f.export("const", name), ": ", GenExtension, "<", E, ", ", V, ">", " = ", pure);
                    f.print("  ", call, ";");
                    f.print();
                    break;
                }
                case "service": {
                    const { GenService, serviceDesc } = f.runtime.codegen;
                    const name = f.importSchema(desc).name;
                    const call = (0, util_js_1.functionCall)(serviceDesc, [fileDesc, ...(0, codegenv2_1.pathInFileDesc)(desc)]);
                    f.print(f.jsDoc(desc));
                    f.print(f.export("const", name), ": ", GenService, "<", getServiceShapeExpr(f, desc), "> = ", pure);
                    f.print("  ", call, ";");
                    f.print();
                    break;
                }
            }
        }
    }
}
// biome-ignore format: want this to read well
function generateJs(schema) {
    for (const file of schema.files) {
        const f = schema.generateFile(file.name + "_pb.js");
        f.preamble(file);
        const fileDesc = f.importSchema(file);
        generateDescDoc(f, file);
        f.print(f.export("const", fileDesc.name), " = ", pure);
        f.print("  ", getFileDescCall(f, file, schema), ";");
        f.print();
        for (const desc of schema.typesInFile(file)) {
            switch (desc.kind) {
                case "message": {
                    const name = f.importSchema(desc).name;
                    generateDescDoc(f, desc);
                    const { messageDesc } = f.runtime.codegen;
                    const call = (0, util_js_1.functionCall)(messageDesc, [fileDesc, ...(0, codegenv2_1.pathInFileDesc)(desc)]);
                    f.print(f.export("const", name), " = ", pure);
                    f.print("  ", call, ";");
                    f.print();
                    break;
                }
                case "enum": {
                    // generate descriptor
                    {
                        generateDescDoc(f, desc);
                        const name = f.importSchema(desc).name;
                        f.print(f.export("const", name), " = ", pure);
                        const { enumDesc } = f.runtime.codegen;
                        const call = (0, util_js_1.functionCall)(enumDesc, [fileDesc, ...(0, codegenv2_1.pathInFileDesc)(desc)]);
                        f.print("  ", call, ";");
                        f.print();
                    }
                    // declare TypeScript enum
                    {
                        f.print(f.jsDoc(desc));
                        f.print(f.export("const", f.importShape(desc).name), " = ", pure);
                        const { tsEnum } = f.runtime.codegen;
                        const call = (0, util_js_1.functionCall)(tsEnum, [f.importSchema(desc)]);
                        f.print("  ", call, ";");
                        f.print();
                    }
                    break;
                }
                case "extension": {
                    f.print(f.jsDoc(desc));
                    const name = f.importSchema(desc).name;
                    f.print(f.export("const", name), " = ", pure);
                    const { extDesc } = f.runtime.codegen;
                    const call = (0, util_js_1.functionCall)(extDesc, [fileDesc, ...(0, codegenv2_1.pathInFileDesc)(desc)]);
                    f.print("  ", call, ";");
                    f.print();
                    break;
                }
                case "service": {
                    f.print(f.jsDoc(desc));
                    const name = f.importSchema(desc).name;
                    f.print(f.export("const", name), " = ", pure);
                    const { serviceDesc } = f.runtime.codegen;
                    const call = (0, util_js_1.functionCall)(serviceDesc, [fileDesc, ...(0, codegenv2_1.pathInFileDesc)(desc)]);
                    f.print("  ", call, ";");
                    f.print();
                    break;
                }
            }
        }
    }
}
// biome-ignore format: want this to read well
function generateDts(schema) {
    for (const file of schema.files) {
        const f = schema.generateFile(file.name + "_pb.d.ts");
        f.preamble(file);
        const { GenFile } = f.runtime.codegen;
        const fileDesc = f.importSchema(file);
        generateDescDoc(f, file);
        f.print(f.export("declare const", fileDesc.name), ": ", GenFile, ";");
        f.print();
        for (const desc of schema.typesInFile(file)) {
            switch (desc.kind) {
                case "message": {
                    generateMessageShape(f, desc, "dts");
                    if (schema.options.jsonTypes) {
                        generateMessageJsonShape(f, desc, "dts");
                    }
                    if (schema.options.validTypes.legacyRequired || schema.options.validTypes.protovalidateRequired) {
                        generateMessageValidShape(f, desc, schema.options.validTypes, "dts");
                    }
                    const name = f.importSchema(desc).name;
                    generateDescDoc(f, desc);
                    f.print(f.export("declare const", name), ": ", (0, util_js_1.messageGenType)(desc, f, schema.options), ";");
                    f.print();
                    break;
                }
                case "enum": {
                    generateEnumShape(f, desc);
                    if (schema.options.jsonTypes) {
                        generateEnumJsonShape(f, desc, "dts");
                    }
                    generateDescDoc(f, desc);
                    const name = f.importSchema(desc).name;
                    const Shape = f.importShape(desc);
                    const { GenEnum } = f.runtime.codegen;
                    if (schema.options.jsonTypes) {
                        const JsonType = f.importJson(desc);
                        f.print(f.export("declare const", name), ": ", GenEnum, "<", Shape, ", ", JsonType, ">;");
                    }
                    else {
                        f.print(f.export("declare const", name), ": ", GenEnum, "<", Shape, ">;");
                    }
                    f.print();
                    break;
                }
                case "extension": {
                    const { GenExtension } = f.runtime.codegen;
                    const name = f.importSchema(desc).name;
                    const E = f.importShape(desc.extendee);
                    const V = (0, util_js_1.fieldTypeScriptType)(desc, f.runtime).typing;
                    f.print(f.jsDoc(desc));
                    f.print(f.export("declare const", name), ": ", GenExtension, "<", E, ", ", V, ">;");
                    f.print();
                    break;
                }
                case "service": {
                    const { GenService } = f.runtime.codegen;
                    const name = f.importSchema(desc).name;
                    f.print(f.jsDoc(desc));
                    f.print(f.export("declare const", name), ": ", GenService, "<", getServiceShapeExpr(f, desc), ">;");
                    f.print();
                    break;
                }
            }
        }
    }
}
function generateDescDoc(f, desc) {
    let lines;
    switch (desc.kind) {
        case "file":
            lines = [`Describes the ${desc.toString()}.`];
            break;
        case "message":
            lines = [
                `Describes the ${desc.toString()}.`,
                `Use \`create(${f.importSchema(desc).name})\` to create a new message.`,
            ];
            break;
        case "enum":
            lines = [`Describes the ${desc.toString()}.`];
            break;
    }
    const deprecated = desc.deprecated || (0, reflect_1.parentTypes)(desc).some((d) => d.deprecated);
    if (deprecated) {
        lines.push("@deprecated");
    }
    f.print({
        kind: "es_jsdoc",
        text: lines.join("\n"),
    });
}
// biome-ignore format: want this to read well
function getFileDescCall(f, file, schema) {
    // Schema provides files with source retention options. Since we do not want to
    // embed source retention options in generated code, we use FileDescriptorProto
    // messages from CodeGeneratorRequest.proto_file instead.
    const sourceFile = file.proto;
    const runtimeFile = schema.proto.protoFile.find(f => f.name == sourceFile.name);
    const info = (0, codegenv2_1.embedFileDesc)(runtimeFile !== null && runtimeFile !== void 0 ? runtimeFile : sourceFile);
    if (info.bootable && !f.runtime.create.from.startsWith("@bufbuild/protobuf")) {
        // google/protobuf/descriptor.proto is embedded as a plain object when
        // bootstrapping to avoid recursion
        return (0, util_js_1.functionCall)(f.runtime.codegen.boot, [JSON.stringify(info.boot())]);
    }
    const { fileDesc } = f.runtime.codegen;
    if (file.dependencies.length > 0) {
        const deps = file.dependencies.map((f) => ({
            kind: "es_desc_ref",
            desc: f,
        }));
        return (0, util_js_1.functionCall)(fileDesc, [
            f.string(info.base64()),
            f.array(deps),
        ]);
    }
    return (0, util_js_1.functionCall)(fileDesc, [f.string(info.base64())]);
}
// biome-ignore format: want this to read well
function getServiceShapeExpr(f, service) {
    const p = ["{\n"];
    for (const method of service.methods) {
        p.push(f.jsDoc(method, "  "), "\n");
        p.push("  ", method.localName, ": {\n");
        p.push("    methodKind: ", f.string(method.methodKind), ";\n");
        p.push("    input: typeof ", f.importSchema(method.input, true), ";\n");
        p.push("    output: typeof ", f.importSchema(method.output, true), ";\n");
        p.push("  },\n");
    }
    p.push("}");
    return p;
}
// biome-ignore format: want this to read well
function generateEnumShape(f, enumeration) {
    f.print(f.jsDoc(enumeration));
    f.print(f.export("enum", f.importShape(enumeration).name), " {");
    for (const value of enumeration.values) {
        if (enumeration.values.indexOf(value) > 0) {
            f.print();
        }
        f.print(f.jsDoc(value, "  "));
        f.print("  ", value.localName, " = ", value.number, ",");
    }
    f.print("}");
    f.print();
}
// biome-ignore format: want this to read well
function generateEnumJsonShape(f, enumeration, target) {
    f.print(f.jsDoc(enumeration));
    const declaration = target == "ts" ? "type" : "declare type";
    const values = [];
    if (enumeration.typeName == "google.protobuf.NullValue") {
        values.push("null");
    }
    else {
        for (const v of enumeration.values) {
            if (enumeration.values.indexOf(v) > 0) {
                values.push(" | ");
            }
            values.push(f.string(v.name));
        }
    }
    f.print(f.export(declaration, f.importJson(enumeration).name), " = ", values, ";");
    f.print();
}
// biome-ignore format: want this to read well
function generateMessageShape(f, message, target) {
    const { Message } = f.runtime;
    const declaration = target == "ts" ? "type" : "declare type";
    f.print(f.jsDoc(message));
    f.print(f.export(declaration, f.importShape(message).name), " = ", Message, "<", f.string(message.typeName), "> & {");
    for (const member of message.members) {
        generateMessageShapeMember(f, member);
        if (message.members.indexOf(member) < message.members.length - 1) {
            f.print();
        }
    }
    f.print("};");
    f.print();
}
// biome-ignore format: want this to read well
function generateMessageValidShape(f, message, validTypes, target) {
    const declaration = target == "ts" ? "type" : "declare type";
    if (!(0, valid_types_js_1.messageNeedsCustomValidType)(message, validTypes)) {
        f.print(f.export(declaration, f.importValid(message).name), " = ", f.importShape(message), ";");
        f.print();
        return;
    }
    f.print(f.jsDoc(message));
    const { Message } = f.runtime;
    f.print(f.export(declaration, f.importValid(message).name), " = ", Message, "<", f.string(message.typeName), "> & {");
    for (const member of message.members) {
        generateMessageShapeMember(f, member, validTypes);
        if (message.members.indexOf(member) < message.members.length - 1) {
            f.print();
        }
    }
    f.print("};");
    f.print();
}
// biome-ignore format: want this to read well
function generateMessageShapeMember(f, member, validTypes) {
    switch (member.kind) {
        case "oneof":
            f.print(f.jsDoc(member, "  "));
            f.print("  ", member.localName, ": {");
            for (const field of member.fields) {
                if (member.fields.indexOf(field) > 0) {
                    f.print(`  } | {`);
                }
                f.print(f.jsDoc(field, "    "));
                const { typing } = (0, util_js_1.fieldTypeScriptType)(field, f.runtime, validTypes && !(0, valid_types_js_1.isProtovalidateDisabled)(field));
                f.print(`    value: `, typing, `;`);
                f.print(`    case: "`, field.localName, `";`);
            }
            f.print(`  } | { case: undefined; value?: undefined };`);
            break;
        case "field":
            f.print(f.jsDoc(member, "  "));
            let { typing, optional } = (0, util_js_1.fieldTypeScriptType)(member, f.runtime, validTypes && !(0, valid_types_js_1.isProtovalidateDisabled)(member));
            if (optional && validTypes) {
                const isRequired = (validTypes.legacyRequired && (0, valid_types_js_1.isLegacyRequired)(member)) || (validTypes.protovalidateRequired && (0, valid_types_js_1.isProtovalidateRequired)(member));
                if (isRequired) {
                    optional = false;
                }
            }
            if (optional) {
                f.print("  ", member.localName, "?: ", typing, " | undefined;");
            }
            else {
                f.print("  ", member.localName, ": ", typing, ";");
            }
            break;
    }
}
// biome-ignore format: want this to read well
function generateMessageJsonShape(f, message, target) {
    const exp = f.export(target == "ts" ? "type" : "declare type", f.importJson(message).name);
    f.print(f.jsDoc(message));
    switch (message.typeName) {
        case "google.protobuf.Any":
            f.print(exp, " = {");
            f.print(`  "@type"?: string;`);
            f.print("};");
            break;
        case "google.protobuf.Timestamp":
            f.print(exp, " = string;");
            break;
        case "google.protobuf.Duration":
            f.print(exp, " = string;");
            break;
        case "google.protobuf.FieldMask":
            f.print(exp, " = string;");
            break;
        case "google.protobuf.Struct":
            f.print(exp, " = ", f.runtime.JsonObject, ";");
            break;
        case "google.protobuf.Value":
            f.print(exp, " = ", f.runtime.JsonValue, ";");
            break;
        case "google.protobuf.ListValue":
            f.print(exp, " = ", f.runtime.JsonValue, "[];");
            break;
        case "google.protobuf.Empty":
            f.print(exp, " = Record<string, never>;");
            break;
        default:
            if ((0, wkt_1.isWrapperDesc)(message)) {
                f.print(exp, " = ", (0, util_js_1.fieldJsonType)(message.fields[0]), ";");
            }
            else {
                f.print(exp, " = {");
                for (const field of message.fields) {
                    f.print(f.jsDoc(field, "  "));
                    let jsonName = field.jsonName;
                    const startWithNumber = /^[0-9]/;
                    const containsSpecialChar = /[^a-zA-Z0-9_$]/;
                    if (jsonName === ""
                        || startWithNumber.test(jsonName)
                        || containsSpecialChar.test(jsonName)) {
                        jsonName = f.string(jsonName);
                    }
                    f.print("  ", jsonName, "?: ", (0, util_js_1.fieldJsonType)(field), ";");
                    if (message.fields.indexOf(field) < message.fields.length - 1) {
                        f.print();
                    }
                }
                f.print("};");
            }
    }
    f.print();
}
