import Foundation
import FoundationModels

struct Request: Decodable {
    let prompt: String
    let choices: [String: [String]]
}

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

guard CommandLine.arguments.count == 2, let data = CommandLine.arguments[1].data(using: .utf8),
      let request = try? JSONDecoder().decode(Request.self, from: data)
else { fail("usage: jev-apple-classify '{\"prompt\":\"...\",\"choices\":{\"placement\":[...]}}'", code: 64) }

let model = SystemLanguageModel.default
guard case .available = model.availability else { fail("apple intelligence unavailable: \(model.availability)", code: 69) }

let choiceProperties = request.choices.keys.sorted().map { key in
    DynamicGenerationSchema.Property(name: key, schema: DynamicGenerationSchema(name: key, anyOf: request.choices[key]!))
}
let root = DynamicGenerationSchema(name: "Verdict", properties: choiceProperties + [
    .init(name: "title", schema: DynamicGenerationSchema(type: String.self)),
    .init(name: "confidence", schema: DynamicGenerationSchema(type: Double.self, guides: [.range(0...1)])),
])

do {
    let schema = try GenerationSchema(root: root, dependencies: [])
    let session = LanguageModelSession(model: model)
    let response = try await session.respond(to: request.prompt, schema: schema, options: GenerationOptions(temperature: 0.1))
    print(response.content.jsonString)
} catch {
    fail("\(error)", code: 1)
}
