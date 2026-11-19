class Animal {
public:
  virtual ~Animal() {}
  virtual const char *sound() const = 0;
  virtual int legs() const { return 4; }
};

class Dog : public Animal {
public:
  const char *sound() const override { return "woof"; }
};

class Bird : public Animal {
public:
  const char *sound() const override { return "tweet"; }
  int legs() override { return 2; }
};

class Secret : private Dog {};

int main() {
  Dog dog;
  Animal generic;
  Animal &ref = dog;
  Secret s;
  Animal *hidden = &s;
  return ref.legs();
}
