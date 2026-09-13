/**
 * Gramática TextMate mínima para diagramas ASCII.
 *
 * Use a cerca ```ascii nos posts. O Shiki aplica o tema normalmente, então
 * as cores acompanham o esquema claro/escuro sem CSS extra.
 *
 * A ordem dos padrões importa: o primeiro que casar vence naquela posição.
 */
export const asciiDiagram = {
  name: 'ascii',
  scopeName: 'source.ascii',
  patterns: [
    // "rótulos entre aspas" nas arestas
    { match: '"[^"]*"', name: 'variable.parameter' },

    // setas e marcadores de nó — recebem a cor de acento
    { match: '[▶◀▲▼→←↑↓⟶⟵●○◆◇✓✗]', name: 'entity.name.tag' },

    // traços das caixas — ficam esmaecidos, viram estrutura e não conteúdo
    { match: '[─│┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬━┃┏┓┗┛]', name: 'comment' },

    // identificadores em PascalCase: GatewayClass, HTTPRoute, Envoy…
    { match: '\\b[A-Z][A-Za-z0-9]+\\b', name: 'constant.numeric' },
  ],
  repository: {},
};

export default asciiDiagram;
