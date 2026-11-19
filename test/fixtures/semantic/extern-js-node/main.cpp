extern "JS" {
  namespace [[js::module("left-pad")]] leftpad {
    const char *leftPad(const char *text, int width);
  }
  namespace console {
    void log(const char *message);
  }
}

int main() {
  return 0;
}
